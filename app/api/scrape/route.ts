import { NextResponse } from "next/server";
import { activeClassifierName } from "@/lib/classifier";
import { dbConfigError, prisma } from "@/lib/db";
import { activeBioSource } from "@/lib/instagram";
import { beginRun, stepRun } from "@/lib/pipeline";
import { currentTerm, nextTerm } from "@/lib/terms";

export const dynamic = "force-dynamic";
// One step can include directory discovery or an Apify run; allow it the time.
export const maxDuration = 300;

/** Latest run + headline stats, polled by the UI. */
export async function GET() {
  const configError = dbConfigError();
  if (configError) return NextResponse.json({ error: configError }, { status: 503 });
  const [run, clubs, bySource, withBio, withNotion, withBioLinks, open] = await Promise.all([
    prisma.scrapeRun.findFirst({ orderBy: { startedAt: "desc" } }),
    prisma.club.count(),
    prisma.club.groupBy({ by: ["source"], _count: { _all: true } }),
    prisma.club.count({ where: { linkInBioUrl: { not: null } } }),
    prisma.club.count({ where: { notionUrl: { not: null } } }),
    prisma.club.count({ where: { bioLinks: { not: null }, NOT: { bioLinks: "[]" } } }),
    prisma.applicationOpportunity.count({ where: { status: { not: "CLOSED" } } }),
  ]);
  const term = currentTerm();
  return NextResponse.json({
    run,
    stats: {
      clubs,
      clubsBySource: Object.fromEntries(bySource.map((g) => [g.source, g._count._all])),
      clubsWithLinkInBio: withBio,
      clubsWithNotion: withNotion,
      clubsWithBioLinks: withBioLinks,
      bioSource: activeBioSource(),
      openOpportunities: open,
      currentTerm: term.code,
      nextTerm: nextTerm(term).code,
      classifier: activeClassifierName(),
    },
  });
}

/**
 * Drive a scan one step at a time (works on serverless hosts, where nothing runs after the
 * response is sent):
 *   POST {}                       → start a run (or return the one in progress)
 *   POST { "runId": "…" }         → do the next piece of work and return the updated run
 * The page keeps calling the second form until the run's status is no longer "RUNNING".
 */
export async function POST(request: Request) {
  const configError = dbConfigError();
  if (configError) return NextResponse.json({ error: configError }, { status: 503 });

  const body = (await request.json().catch(() => ({}))) as { runId?: string; skipDiscovery?: boolean };
  if (!body.runId) {
    const run = await beginRun({ skipDiscovery: Boolean(body.skipDiscovery) });
    return NextResponse.json({ run, busy: false }, { status: 201 });
  }
  const { run, busy } = await stepRun(body.runId);
  if (!run) return NextResponse.json({ error: "Run not found." }, { status: 404 });
  return NextResponse.json({ run, busy });
}
