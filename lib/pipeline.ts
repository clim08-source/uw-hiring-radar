// Orchestrates discovery → link-in-bio resolution → scrape → classify → persist.
// `npm run scrape` runs it start to finish (runPipeline); the web app runs it as resumable
// steps (beginRun / stepRun) so it also works on serverless hosts.

import { activeClassifierName } from "./classifier";
import { prisma } from "./db";
import { discoverAll, isLinkInBioUrl, resolveLinkInBio, type ClubSource, type DiscoveredClub } from "./discovery";
import { mapLimit, normalizeUrl } from "./http";
import { activeBioSource, fetchInstagramBios } from "./instagram";
import { findNotionSite, isNotionSiteUrl } from "./notion";
import { scrapeClubLinks, scrapeDestination, type ClubScrapeResult } from "./scraper";

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

const NOTION_RECHECK_MS = 7 * 24 * 3600 * 1000;
const BIO_RECHECK_MS = 20 * 3600 * 1000;
const MAX_BIO_TARGETS = 4;

function parseBioLinks(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((u): u is string => typeof u === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Step B: read Instagram bios for every club with a handle whose bio is stale, in one batch.
 * Returns how many bios came back. With no APIFY_API_TOKEN / SERPER_API_KEY this is a no-op and
 * clubs fall back to the website listed on WUSA / Sedra.
 */
export async function refreshInstagramBios(clubIds: string[] | null, now: Date = new Date()): Promise<{ found: number; error: string | null }> {
  if (!activeBioSource()) return { found: 0, error: null };
  const clubs = await prisma.club.findMany({
    where: {
      instagramHandle: { not: null },
      ...(clubIds ? { id: { in: clubIds } } : {}),
      OR: [{ bioCheckedAt: null }, { bioCheckedAt: { lt: new Date(now.getTime() - BIO_RECHECK_MS) } }],
    },
    select: { id: true, instagramHandle: true, linkInBioUrl: true },
  });
  if (clubs.length === 0) return { found: 0, error: null };

  const { source, bios, error } = await fetchInstagramBios(clubs.map((c) => c.instagramHandle!));
  for (const club of clubs) {
    const bio = bios.get(club.instagramHandle!.toLowerCase());
    // A handle with no result is left unchecked so the next scan retries it.
    if (!bio) continue;
    const bioLinkInBio = bio.links.find(isLinkInBioUrl) ?? null;
    await prisma.club.update({
      where: { id: club.id },
      data: {
        instagramBio: bio.biography?.slice(0, 1000) ?? null,
        bioLinks: JSON.stringify(bio.links),
        bioSource: source,
        bioCheckedAt: now,
        // The bio is the most current source for a club's Linktree.
        linkInBioUrl: bioLinkInBio ?? club.linkInBioUrl,
      },
    });
  }
  return { found: bios.size, error };
}

/** Scrape one club (link-in-bio page plus its Notion site) and reconcile its opportunities. */
export async function scrapeClub(clubId: string, now: Date = new Date()): Promise<number> {
  const club = await prisma.club.findUnique({ where: { id: clubId } });
  if (!club) return 0;

  const results: ClubScrapeResult[] = [];

  // Step C: every link from the Instagram bio, whichever of the four destination types it is.
  const bioTargets = parseBioLinks(club.bioLinks).slice(0, MAX_BIO_TARGETS);
  for (const target of bioTargets) results.push(await scrapeDestination(club.name, target, now, club.instagramBio ?? ""));
  const alreadyScraped = new Set(bioTargets.map((u) => normalizeUrl(u) ?? u));

  // Fallback / supplement: the link-in-bio or website known from WUSA / Sedra.
  const resolved = await resolveLinkInBio(club);
  if (resolved && !alreadyScraped.has(normalizeUrl(resolved.url) ?? resolved.url)) {
    // Remember a genuine link-in-bio / join page; a bare website fallback is not stored as one.
    if (!club.linkInBioUrl && resolved.via !== "website") {
      await prisma.club.update({ where: { id: club.id }, data: { linkInBioUrl: resolved.url } });
    }
    results.push(await scrapeDestination(club.name, resolved.url, now, club.instagramBio ?? ""));
  }

  // Also look for <clubname>.notion.site, unless the page above already was the Notion site.
  // The subdomain search is repeated at most weekly; a known site is re-read on every scan.
  if (!resolved || !isNotionSiteUrl(resolved.url)) {
    let notionUrl = club.notionUrl;
    const stale = !club.notionCheckedAt || now.getTime() - club.notionCheckedAt.getTime() > NOTION_RECHECK_MS;
    if (stale) {
      const search = await findNotionSite(club);
      if (search.site || search.complete) {
        notionUrl = search.site ? `https://${search.site.domain}.notion.site` : null;
        await prisma.club.update({ where: { id: club.id }, data: { notionUrl, notionCheckedAt: now } });
      }
    }
    // A workspace with no public home page yields an unreachable result with nothing in it.
    if (notionUrl) {
      const notion = await scrapeClubLinks(club.name, notionUrl, now);
      if (notion.reachable) results.push(notion);
    }
  }

  await prisma.club.update({ where: { id: club.id }, data: { lastScrapedAt: now } });
  if (results.length === 0) return 0;

  const seen = new Set<string>();
  const opportunities = results.flatMap((r) => r.opportunities).filter((o) => (seen.has(o.url) ? false : (seen.add(o.url), true)));

  for (const opp of opportunities) {
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

  // Links that disappeared, or stopped classifying as hiring, are closed — but only when every
  // page was reachable, so a network blip doesn't close live applications.
  if (results.every((r) => r.reachable)) {
    await prisma.applicationOpportunity.updateMany({
      where: { clubId: club.id, url: { notIn: [...seen] }, status: { not: "CLOSED" } },
      data: { status: "CLOSED", lastVerifiedAt: now, reason: "no longer listed on the club's page" },
    });
  }

  return opportunities.filter((o) => o.status !== "CLOSED").length;
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
    // Step B: Instagram bio links (Apify, else Serper, else skipped).
    const bioSource = activeBioSource();
    if (bioSource) {
      await prisma.scrapeRun.update({ where: { id: runId }, data: { phase: `reading Instagram bios (${bioSource})`, bioSource, clubsTotal: clubs.length } });
      const bios = await refreshInstagramBios(clubs.map((c) => c.id), now);
      await prisma.scrapeRun.update({ where: { id: runId }, data: { biosFound: bios.found, bioError: bios.error?.slice(0, 300) ?? null } });
    }

    await prisma.scrapeRun.update({ where: { id: runId }, data: { phase: "scraping bio destinations", clubsTotal: clubs.length } });

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

// ---------------------------------------------------------------------------------------------
// Web runs: resumable steps
// ---------------------------------------------------------------------------------------------
// A serverless host (Vercel) stops a function when its response is sent, so a scan cannot run in
// the background of one request. Instead the browser drives it: each POST /api/scrape does one
// bounded piece of work, saves progress on the ScrapeRun row, and returns. Closing the tab
// pauses the scan; reopening the page resumes it.

const PHASE_DISCOVER = "discovering clubs";
const PHASE_BIOS = "reading Instagram bios";
const PHASE_SCRAPE = "scraping bio destinations";
const STEP_BATCH = 6;
const STEP_LOCK_MS = 6 * 60 * 1000;
const RUN_STALE_MS = 3 * 3600 * 1000;

/** Create a run, or return the one already in progress. */
export async function beginRun(opts: { skipDiscovery?: boolean } = {}) {
  const active = await prisma.scrapeRun.findFirst({
    where: { status: "RUNNING", startedAt: { gt: new Date(Date.now() - RUN_STALE_MS) } },
    orderBy: { startedAt: "desc" },
  });
  if (active) return active;
  await prisma.scrapeRun.updateMany({ where: { status: "RUNNING" }, data: { status: "FAILED", phase: "interrupted", finishedAt: new Date() } });
  return prisma.scrapeRun.create({
    data: { phase: opts.skipDiscovery ? PHASE_BIOS : PHASE_DISCOVER, classifier: activeClassifierName(), bioSource: activeBioSource() },
  });
}

/** Do the next piece of work for a run. `busy` means another request holds the run right now. */
export async function stepRun(runId: string) {
  const now = new Date();
  const lock = await prisma.scrapeRun.updateMany({
    where: { id: runId, status: "RUNNING", OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] },
    data: { lockedUntil: new Date(now.getTime() + STEP_LOCK_MS) },
  });
  const run = await prisma.scrapeRun.findUnique({ where: { id: runId } });
  if (!run || lock.count === 0) return { run, busy: run?.status === "RUNNING" };

  try {
    if (run.phase === PHASE_DISCOVER) {
      const discovered = await discoverAll();
      for (const c of discovered) await upsertClub(c);
      await prisma.scrapeRun.update({
        where: { id: runId },
        data: { clubsDiscovered: discovered.length, clubsTotal: await prisma.club.count(), phase: PHASE_BIOS },
      });
    } else if (run.phase === PHASE_BIOS) {
      const bios = activeBioSource() ? await refreshInstagramBios(null, now) : { found: 0, error: null };
      await prisma.scrapeRun.update({
        where: { id: runId },
        data: { biosFound: bios.found, bioError: bios.error?.slice(0, 300) ?? null, clubsTotal: await prisma.club.count(), phase: PHASE_SCRAPE },
      });
    } else {
      // Clubs not yet scraped during this run.
      const pending = { OR: [{ lastScrapedAt: null }, { lastScrapedAt: { lt: run.startedAt } }] };
      const batch = await prisma.club.findMany({ where: pending, select: { id: true }, take: STEP_BATCH });
      await mapLimit(batch, 3, async (club) => {
        try {
          await scrapeClub(club.id, new Date());
        } catch (err) {
          console.warn(`[pipeline] scrape failed for club ${club.id}:`, (err as Error).message);
          // Mark it attempted so one broken club cannot stall the run.
          await prisma.club.update({ where: { id: club.id }, data: { lastScrapedAt: new Date() } });
        }
      });
      const [remaining, total, found] = await Promise.all([
        prisma.club.count({ where: pending }),
        prisma.club.count(),
        prisma.applicationOpportunity.count({ where: { status: { not: "CLOSED" }, lastVerifiedAt: { gte: run.startedAt } } }),
      ]);
      const done = remaining === 0;
      await prisma.scrapeRun.update({
        where: { id: runId },
        data: {
          clubsTotal: total,
          clubsScraped: total - remaining,
          opportunitiesFound: found,
          ...(done ? { status: "DONE", phase: "done", finishedAt: new Date() } : {}),
        },
      });
    }
  } catch (err) {
    await prisma.scrapeRun.update({
      where: { id: runId },
      data: { status: "FAILED", phase: "failed", error: (err as Error).message.slice(0, 500), finishedAt: new Date() },
    });
  }

  const updated = await prisma.scrapeRun.update({ where: { id: runId }, data: { lockedUntil: null } });
  return { run: updated, busy: false };
}
