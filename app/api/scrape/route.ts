import { NextResponse } from "next/server";
import { activeClassifierName } from "@/lib/classifier";
import { prisma } from "@/lib/db";
import { activeBioSource } from "@/lib/instagram";
import type { ClubSource } from "@/lib/discovery";
import { startPipeline } from "@/lib/pipeline";
import { currentTerm, nextTerm } from "@/lib/terms";

export const dynamic = "force-dynamic";

/** Latest run + headline stats, polled by the UI. */
export async function GET() {
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
 * Start discovery + scraping in the background.
 * Body (all optional): { "limit": 10, "sources": ["WUSA","DESIGN_TEAM"], "skipDiscovery": false }
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { limit?: number; sources?: string[]; skipDiscovery?: boolean };
  const sources = body.sources?.filter((s): s is ClubSource => s === "WUSA" || s === "DESIGN_TEAM");
  const limit = Number(body.limit);
  const { runId, alreadyRunning } = await startPipeline({
    sources: sources?.length ? sources : undefined,
    limitPerSource: Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : undefined,
    skipDiscovery: Boolean(body.skipDiscovery),
  });
  return NextResponse.json({ runId, alreadyRunning }, { status: alreadyRunning ? 200 : 202 });
}
