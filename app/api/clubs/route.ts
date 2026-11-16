import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { instagramHandleFromUrl, isLinkInBioUrl } from "@/lib/discovery";
import { isHttpUrl, normalizeUrl } from "@/lib/http";
import { scrapeClub } from "@/lib/pipeline";

export const dynamic = "force-dynamic";

export async function GET() {
  const clubs = await prisma.club.findMany({
    orderBy: { name: "asc" },
    include: { _count: { select: { opportunities: { where: { status: { not: "CLOSED" } } } } } },
  });
  return NextResponse.json({ clubs });
}

/** Add a custom club by its link-in-bio / website URL and scrape it right away. */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { name?: string; url?: string; instagram?: string };
  const name = body.name?.trim();
  const url = body.url?.trim() ? normalizeUrl(body.url.trim().replace(/^(?!https?:\/\/)/i, "https://")) : null;
  if (!name) return NextResponse.json({ error: "A club name is required." }, { status: 400 });
  if (!url || !isHttpUrl(url)) return NextResponse.json({ error: "A valid link-in-bio or website URL is required." }, { status: 400 });

  const handle = body.instagram?.trim()
    ? (instagramHandleFromUrl(body.instagram.trim()) ?? body.instagram.trim().replace(/^@/, "").toLowerCase())
    : null;

  const club = await prisma.club.create({
    data: {
      name,
      source: "CUSTOM",
      externalId: null,
      category: "Custom",
      instagramHandle: handle,
      linkInBioUrl: isLinkInBioUrl(url) ? url : null,
      websiteUrl: isLinkInBioUrl(url) ? null : url,
    },
  });
  const found = await scrapeClub(club.id).catch(() => 0);
  return NextResponse.json({ club, opportunitiesFound: found }, { status: 201 });
}
