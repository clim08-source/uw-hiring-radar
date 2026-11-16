// Orchestrates discovery → link-in-bio resolution → scrape → classify → persist.
// Used by /api/scrape (runs in the background of the Node server) and by `npm run scrape`.

import { activeClassifierName } from "./classifier";
import { prisma } from "./db";
import { discoverAll, resolveLinkInBio, type ClubSource, type DiscoveredClub } from "./discovery";
import { mapLimit } from "./http";
import { scrapeClubLinks } from "./scraper";

export interface PipelineOptions {
  /** Which directories to (re)discover. Default: WUSA + design teams. */
  sources?: ClubSource[];
  /** Cap on clubs per source — handy for a quick test run. */
  limitPerSource?: number;
  /** Skip directory discovery and only re-scrape clubs already in the database. */
  skipDiscovery?: boolean;
}

async function upsertClub(c: DiscoveredClub) {
  const existing = await prisma.club.findUnique({ where: { source_externalId: { source: c.source, externalId: c.externalId } } });
  const data = {
    name: c.name,
    category: c.category,
    description: c.description,
    sourceUrl: c.sourceUrl,
    // Keep values we resolved earlier when the directory has nothing for them.
    instagramHandle: c.instagramHandle ?? existing?.instagramHandle ?? null,
    websiteUrl: c.websiteUrl ?? existing?.websiteUrl ?? null,
    linkInBioUrl: c.linkInBioUrl ?? existing?.linkInBioUrl ?? null,
  };
  if (existing) return prisma.club.update({ where: { id: existing.id }, data });
  return prisma.club.create({ data: { ...data, source: c.source, externalId: c.externalId } });
}

/** Scrape one club and reconcile its opportunities. Returns the number of live opportunities. */
export async function scrapeClub(clubId: string, now: Date = new Date()): Promise<number> {
  const club = await prisma.club.findUnique({ where: { id: clubId } });
  if (!club) return 0;

  const resolved = await resolveLinkInBio(club);
  if (!resolved) {
    await prisma.club.update({ where: { id: club.id }, data: { lastScrapedAt: now } });
    return 0;
  }
  // Remember a genuine link-in-bio / join page; a bare website fallback is not stored as one.
  if (!club.linkInBioUrl && resolved.via !== "website") {
    await prisma.club.update({ where: { id: club.id }, data: { linkInBioUrl: resolved.url } });
  }

  const result = await scrapeClubLinks(club.name, resolved.url, now);
  if (!result.reachable) {
    // Page unreachable: leave existing opportunities alone rather than closing them on a blip.
    await prisma.club.update({ where: { id: club.id }, data: { lastScrapedAt: now } });
    return 0;
  }

  const liveUrls: string[] = [];
  for (const opp of result.opportunities) {
    liveUrls.push(opp.url);
    const data = {
      title: opp.title,
      targetTerm: opp.targetTerm,
      roleType: opp.roleType,
      status: opp.status,
      formProvider: opp.formProvider,
      deadline: opp.deadline,
      confidence: opp.confidence,
      classifier: opp.classifier,
      reason: opp.reason,
      lastVerifiedAt: now,
    };
    await prisma.applicationOpportunity.upsert({
      where: { clubId_url: { clubId: club.id, url: opp.url } },
      update: data,
      create: { ...data, clubId: club.id, url: opp.url },
    });
  }

  // Links that disappeared from the page, or stopped classifying as hiring, are closed.
  await prisma.applicationOpportunity.updateMany({
    where: { clubId: club.id, url: { notIn: liveUrls }, status: { not: "CLOSED" } },
    data: { status: "CLOSED", lastVerifiedAt: now, reason: "no longer listed on the club's page" },
  });

  await prisma.club.update({ where: { id: club.id }, data: { lastScrapedAt: now } });
  return result.opportunities.filter((o) => o.status !== "CLOSED").length;
}

export async function runPipeline(runId: string, opts: PipelineOptions = {}): Promise<void> {
  const now = new Date();
  try {
    await prisma.scrapeRun.update({ where: { id: runId }, data: { classifier: activeClassifierName(), phase: "discovering clubs" } });

    let discoveredIds: string[] | null = null;
    if (!opts.skipDiscovery) {
      const discovered = await discoverAll({ sources: opts.sources, limitPerSource: opts.limitPerSource });
      discoveredIds = [];
      for (const c of discovered) discoveredIds.push((await upsertClub(c)).id);
      await prisma.scrapeRun.update({ where: { id: runId }, data: { clubsDiscovered: discovered.length } });
    }

    // A limited run scrapes just what it discovered (plus custom clubs); a full run scrapes everything.
    const clubs = await prisma.club.findMany({
      where: opts.limitPerSource && discoveredIds ? { OR: [{ id: { in: discoveredIds } }, { source: "CUSTOM" }] } : undefined,
      select: { id: true },
      orderBy: { lastScrapedAt: { sort: "asc", nulls: "first" } },
    });
    await prisma.scrapeRun.update({ where: { id: runId }, data: { phase: "scraping link-in-bio pages", clubsTotal: clubs.length } });

    let scraped = 0;
    let found = 0;
    await mapLimit(clubs, 5, async (club) => {
      try {
        const live = await scrapeClub(club.id, now);
        found += live;
      } catch (err) {
        console.warn(`[pipeline] scrape failed for club ${club.id}:`, (err as Error).message);
      }
      scraped += 1;
      if (scraped % 3 === 0 || scraped === clubs.length) {
        await prisma.scrapeRun.update({ where: { id: runId }, data: { clubsScraped: scraped, opportunitiesFound: found } });
      }
    });

    await prisma.scrapeRun.update({
      where: { id: runId },
      data: { status: "DONE", phase: "done", clubsScraped: scraped, opportunitiesFound: found, finishedAt: new Date() },
    });
  } catch (err) {
    await prisma.scrapeRun.update({
      where: { id: runId },
      data: { status: "FAILED", phase: "failed", error: (err as Error).message.slice(0, 500), finishedAt: new Date() },
    });
  }
}

const globalForRun = globalThis as unknown as { activeScrape?: Promise<void> | null };

/** Start a pipeline run in the background. Returns the existing run if one is in flight. */
export async function startPipeline(opts: PipelineOptions = {}): Promise<{ runId: string; alreadyRunning: boolean }> {
  if (globalForRun.activeScrape) {
    const running = await prisma.scrapeRun.findFirst({ where: { status: "RUNNING" }, orderBy: { startedAt: "desc" } });
    if (running) return { runId: running.id, alreadyRunning: true };
  }
  // Any RUNNING row left by a server restart is stale.
  await prisma.scrapeRun.updateMany({ where: { status: "RUNNING" }, data: { status: "FAILED", phase: "interrupted", finishedAt: new Date() } });
  const run = await prisma.scrapeRun.create({ data: {} });
  globalForRun.activeScrape = runPipeline(run.id, opts).finally(() => {
    globalForRun.activeScrape = null;
  });
  return { runId: run.id, alreadyRunning: false };
}
