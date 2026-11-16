// Automated directory discovery for UWaterloo clubs and student design teams.
//
// Source 1 — WUSA Clubs Directory (https://clubs.wusa.ca). The site is a JS app, so the public
//   club pages (/club/[id]) are read through the same public JSON endpoints the page itself calls:
//   POST /api/v1/clubs_listing/active  and  GET /api/v1/clubs/[id]/profile.
// Source 2 — Sedra Student Design Centre directory of teams (server-rendered HTML).
//
// Link-in-bio resolution then looks for a Linktree / Beacons / Carrd / join / apply page.

import * as cheerio from "cheerio";
import { fetchPage, hostMatches, hostOf, mapLimit, normalizeUrl } from "./http";

export type ClubSource = "WUSA" | "DESIGN_TEAM" | "CUSTOM";

export interface DiscoveredClub {
  name: string;
  source: ClubSource;
  externalId: string;
  category: string | null;
  description: string | null;
  instagramHandle: string | null;
  websiteUrl: string | null;
  linkInBioUrl: string | null;
  sourceUrl: string;
}

export const WUSA_BASE = "https://clubs.wusa.ca";
export const SEDRA_DIRECTORY_URL =
  "https://uwaterloo.ca/sedra-student-design-centre/catalogs/directory-teams/category/all-student-design-teams";

export const LINK_IN_BIO_HOSTS = [
  "linktr.ee",
  "beacons.ai",
  "carrd.co",
  "bio.link",
  "lnk.bio",
  "campsite.bio",
  "linkin.bio",
  "taplink.cc",
  "bio.site",
  "flow.page",
  "msha.ke",
  "solo.to",
  "allmylinks.com",
  "linkpop.com",
  "hoo.be",
  "withkoji.com",
  "magic.ly",
];

const SOCIAL_HOSTS = [
  "instagram.com",
  "facebook.com",
  "fb.com",
  "fb.me",
  "twitter.com",
  "x.com",
  "linkedin.com",
  "tiktok.com",
  "youtube.com",
  "youtu.be",
  "discord.gg",
  "discord.com",
  "github.com",
  "twitch.tv",
  "spotify.com",
  "reddit.com",
  "threads.net",
  "wechat.com",
  "whatsapp.com",
  "t.me",
  "medium.com",
];

const JOIN_PATH = /\/(join|join-us|joinus|apply|applications?|recruit(ment|ing)?|careers?|hiring|get-involved|getinvolved|opportunities|positions|team\/join)(\/|$|\?)/i;
const JOIN_TEXT = /\b(join( us| the team| our team)?|apply( now)?|applications?|recruit(ment|ing)?|we'?re hiring|hiring|careers?|get involved|open (roles|positions))\b/i;

export function isLinkInBioUrl(url: string): boolean {
  return hostMatches(url, LINK_IN_BIO_HOSTS);
}

export function instagramHandleFromUrl(url: string): string | null {
  if (!hostMatches(url, ["instagram.com"])) return null;
  try {
    const seg = new URL(url).pathname.split("/").filter(Boolean)[0];
    if (!seg || ["p", "reel", "reels", "explore", "stories", "accounts"].includes(seg)) return null;
    return seg.replace(/^@/, "").toLowerCase();
  } catch {
    return null;
  }
}

/** Sort a bag of external URLs into instagram / link-in-bio / website. */
function sortExternalLinks(urls: string[]): Pick<DiscoveredClub, "instagramHandle" | "websiteUrl" | "linkInBioUrl"> {
  let instagramHandle: string | null = null;
  let websiteUrl: string | null = null;
  let linkInBioUrl: string | null = null;
  for (const raw of urls) {
    const url = normalizeUrl(raw);
    if (!url) continue;
    if (!instagramHandle) instagramHandle = instagramHandleFromUrl(url);
    if (!linkInBioUrl && isLinkInBioUrl(url)) linkInBioUrl = url;
    if (
      !websiteUrl &&
      !isLinkInBioUrl(url) &&
      !hostMatches(url, SOCIAL_HOSTS) &&
      !hostMatches(url, ["uwaterloo.ca", "wusa.ca", "atlassian.net", "google.com", "goo.gl"])
    ) {
      websiteUrl = url;
    }
  }
  return { instagramHandle, websiteUrl, linkInBioUrl };
}

// ---------------------------------------------------------------------------------------------
// Source 1: WUSA clubs directory
// ---------------------------------------------------------------------------------------------

interface WusaListingClub {
  id: number;
  name: string;
  tagline?: string | null;
  social_url?: string | null;
}

interface WusaProfile {
  id: number;
  name: string;
  description?: string | null;
  tagline?: string | null;
  categories?: { name: string }[];
  socials?: { key?: string; url?: string | null; handle?: string | null }[];
}

async function fetchWusaListing(limit?: number): Promise<WusaListingClub[]> {
  const clubs: WusaListingClub[] = [];
  const rows = 100;
  for (let page = 1; page <= 20; page++) {
    const res = await fetchPage(`${WUSA_BASE}/api/v1/clubs_listing/active`, {
      method: "POST",
      body: JSON.stringify({ page, rows }),
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      timeoutMs: 20_000,
    });
    if (!res.ok) break;
    let data: { clubs?: WusaListingClub[]; total_records?: number } | undefined;
    try {
      data = JSON.parse(res.text).data;
    } catch {
      break;
    }
    const batch = data?.clubs ?? [];
    clubs.push(...batch);
    if (batch.length < rows || clubs.length >= (data?.total_records ?? 0)) break;
    if (limit && clubs.length >= limit) break;
  }
  return limit ? clubs.slice(0, limit) : clubs;
}

export async function discoverWusaClubs(limit?: number): Promise<DiscoveredClub[]> {
  const listing = await fetchWusaListing(limit);
  const clubs = await mapLimit(listing, 6, async (item): Promise<DiscoveredClub> => {
    const urls: string[] = [];
    if (item.social_url && !item.social_url.startsWith("mailto:")) urls.push(item.social_url);
    let category: string | null = null;
    let description: string | null = item.tagline ?? null;

    const res = await fetchPage(`${WUSA_BASE}/api/v1/clubs/${item.id}/profile`, {
      headers: { Accept: "application/json" },
    });
    if (res.ok) {
      try {
        const profile: WusaProfile = JSON.parse(res.text).data;
        category = profile.categories?.map((c) => c.name).join(", ") || null;
        description = profile.tagline ?? profile.description ?? description;
        for (const social of profile.socials ?? []) {
          if (social.url && /^https?:/i.test(social.url)) urls.push(social.url);
        }
        // Clubs often paste their Linktree into the free-text description.
        for (const m of (profile.description ?? "").matchAll(/https?:\/\/[^\s)"'<>]+/g)) urls.push(m[0]);
      } catch {
        // keep listing-level data
      }
    }

    return {
      name: item.name.trim(),
      source: "WUSA",
      externalId: String(item.id),
      category,
      description: description ? description.slice(0, 500) : null,
      sourceUrl: `${WUSA_BASE}/club/${item.id}`,
      ...sortExternalLinks(urls),
    };
  });
  return clubs;
}

// ---------------------------------------------------------------------------------------------
// Source 2: Sedra Student Design Centre teams
// ---------------------------------------------------------------------------------------------

export async function discoverDesignTeams(limit?: number): Promise<DiscoveredClub[]> {
  const res = await fetchPage(SEDRA_DIRECTORY_URL, { timeoutMs: 20_000 });
  if (!res.ok) return [];
  const $ = cheerio.load(res.text);

  const entries: { name: string; url: string; summary: string | null }[] = [];
  const seen = new Set<string>();
  $(".views-field-title a[href*='/sedra-student-design-centre/catalogs/']").each((_, el) => {
    const href = $(el).attr("href");
    const name = $(el).text().trim();
    if (!href || !name || href.includes("/category/")) return;
    const url = new URL(href, SEDRA_DIRECTORY_URL).toString();
    if (seen.has(url)) return;
    seen.add(url);
    const summary = $(el).closest("li").find(".views-field-field-uw-catalog-summary").text().trim() || null;
    entries.push({ name, url, summary });
  });

  const selected = limit ? entries.slice(0, limit) : entries;
  return mapLimit(selected, 5, async (entry): Promise<DiscoveredClub> => {
    const urls: string[] = [];
    const page = await fetchPage(entry.url);
    if (page.ok) {
      const $$ = cheerio.load(page.text);
      // Team socials live in the catalog item body; the site footer has the university's own.
      let scope = $$(".card__node--catalog-item, .node__content").first();
      if (scope.length === 0) scope = $$("main");
      scope.find("a[href^='http']").each((_, a) => {
        const href = $$(a).attr("href");
        if (href && !/instagram\.com\/uofwaterloo|university\.waterloo|school\/uwaterloo|user\/uwaterloo/i.test(href)) {
          urls.push(href);
        }
      });
    }
    return {
      name: entry.name,
      source: "DESIGN_TEAM",
      externalId: entry.url.split("/").filter(Boolean).pop() ?? entry.name,
      category: "Student Design Team",
      description: entry.summary ? entry.summary.slice(0, 500) : null,
      sourceUrl: entry.url,
      ...sortExternalLinks(urls),
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Link-in-bio resolution
// ---------------------------------------------------------------------------------------------

export interface ResolvedLink {
  url: string;
  via: "known" | "website-link" | "website-join-page" | "linktree-handle" | "website";
}

/**
 * Find the best page to scrape for a club:
 *  1. a link-in-bio URL we already know,
 *  2. a link-in-bio or /join | /apply link in the club website's header / footer / nav,
 *  3. linktr.ee/<instagram handle> when that page verifiably belongs to the club,
 *  4. the club website itself.
 */
export async function resolveLinkInBio(club: {
  name: string;
  instagramHandle: string | null;
  websiteUrl: string | null;
  linkInBioUrl: string | null;
}): Promise<ResolvedLink | null> {
  if (club.linkInBioUrl) return { url: club.linkInBioUrl, via: "known" };

  if (club.websiteUrl) {
    const page = await fetchPage(club.websiteUrl);
    if (page.ok) {
      const $ = cheerio.load(page.text);
      const siteHost = hostOf(page.finalUrl);
      let bioLink: string | null = null;
      let joinLink: string | null = null;
      // Header / nav / footer first, then the rest of the page.
      const anchors = [...$("header a, nav a, footer a").toArray(), ...$("a").toArray()];
      for (const a of anchors) {
        const href = normalizeUrl($(a).attr("href") ?? "", page.finalUrl);
        if (!href) continue;
        if (!bioLink && isLinkInBioUrl(href)) bioLink = href;
        if (!joinLink && hostOf(href) === siteHost && href !== normalizeUrl(page.finalUrl)) {
          const text = $(a).text().replace(/\s+/g, " ").trim();
          if (JOIN_PATH.test(new URL(href).pathname) || (text.length < 40 && JOIN_TEXT.test(text))) joinLink = href;
        }
      }
      if (bioLink) return { url: bioLink, via: "website-link" };
      if (joinLink) return { url: joinLink, via: "website-join-page" };
    }
  }

  if (club.instagramHandle) {
    const guess = `https://linktr.ee/${club.instagramHandle}`;
    const page = await fetchPage(guess);
    if (page.ok && linktreeBelongsTo(page.text, club)) return { url: guess, via: "linktree-handle" };
  }

  if (club.websiteUrl) return { url: club.websiteUrl, via: "website" };
  return null;
}

/** Guard against a same-named Linktree owned by someone else. */
function linktreeBelongsTo(html: string, club: { name: string; instagramHandle: string | null; websiteUrl: string | null }): boolean {
  const lower = html.toLowerCase();
  if (club.instagramHandle && lower.includes(`instagram.com/${club.instagramHandle.toLowerCase()}`)) return true;
  if (club.websiteUrl && lower.includes(hostOf(club.websiteUrl))) return true;
  return /uwaterloo|university of waterloo|waterloo/.test(lower);
}

export async function discoverAll(opts: { sources?: ClubSource[]; limitPerSource?: number } = {}): Promise<DiscoveredClub[]> {
  const sources = opts.sources ?? ["WUSA", "DESIGN_TEAM"];
  const [wusa, teams] = await Promise.all([
    sources.includes("WUSA") ? discoverWusaClubs(opts.limitPerSource) : Promise.resolve([]),
    sources.includes("DESIGN_TEAM") ? discoverDesignTeams(opts.limitPerSource) : Promise.resolve([]),
  ]);
  return [...teams, ...wusa];
}
