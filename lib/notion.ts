// Notion site support: find a club's <clubname>.notion.site and read its public pages.
//
// Notion sites are rendered entirely in the browser, so plain HTML fetching returns an empty
// shell. Instead this uses the same public JSON endpoints the page calls:
//   POST /api/v3/getPublicPageDataForDomain  → does the subdomain exist, and its public home page id
//   POST /api/v3/loadPageChunk               → the blocks (text, links, sub-pages) of a public page
//
// Limit worth knowing: Notion only reveals a workspace's *home* page. If a club's workspace exists
// but has no public home page, its individually shared pages cannot be listed — they are only
// reachable when the club links to them (those links are read through `loadNotionPage` too).

import type { CandidateLink } from "./classifier";
import { hostOf, mapLimit } from "./http";

const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

// Notion sits behind Cloudflare, which answers bursts with HTTP 429 and a bot challenge. So every
// request goes through one queue, about one per second, and the first 429 stops all Notion
// lookups for a while instead of retrying into the challenge.
const MIN_GAP_MS = 1000;
const COOL_OFF_MS = 20 * 60 * 1000;
const globalForNotion = globalThis as unknown as { notionQueue?: Promise<unknown>; notionBlockedUntil?: number };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** True while Notion lookups are paused after a rate-limit response. */
export function notionIsCoolingOff(): boolean {
  return (globalForNotion.notionBlockedUntil ?? 0) > Date.now();
}

interface NotionResponse<T> {
  /** False when Notion could not be asked (rate limit, network), as opposed to answering "no". */
  ok: boolean;
  data: T | null;
}

async function notionPost<T>(domain: string, endpoint: string, body: unknown): Promise<NotionResponse<T>> {
  const run = async (): Promise<NotionResponse<T>> => {
    if (notionIsCoolingOff()) return { ok: false, data: null };
    try {
      const res = await fetch(`https://${domain}.notion.site/api/v3/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(12_000),
      });
      if (res.status === 429 || res.status === 403) {
        globalForNotion.notionBlockedUntil = Date.now() + COOL_OFF_MS;
        console.warn("[notion] rate limited; pausing Notion lookups for 20 minutes");
        return { ok: false, data: null };
      }
      await sleep(MIN_GAP_MS);
      if (!res.ok) return { ok: res.status < 500, data: null };
      return { ok: true, data: (await res.json()) as T };
    } catch {
      return { ok: false, data: null };
    }
  };
  const next = (globalForNotion.notionQueue ?? Promise.resolve()).then(run, run);
  globalForNotion.notionQueue = next.catch(() => undefined);
  return next;
}

// ---------------------------------------------------------------------------------------------
// Finding the site
// ---------------------------------------------------------------------------------------------

export interface NotionSite {
  domain: string; // "uwpm" for uwpm.notion.site
  spaceName: string;
  /** Public home page id, or null when the workspace exists but publishes no home page. */
  homePageId: string | null;
}

export interface NotionProbe {
  /** False when Notion could not be asked, so "no site" must not be concluded. */
  answered: boolean;
  site: NotionSite | null;
}

export async function probeNotionSite(domain: string): Promise<NotionProbe> {
  const { ok, data } = await notionPost<{ spaceName?: string; spaceDomain?: string; pageId?: string; publicAccessRole?: string }>(
    domain,
    "getPublicPageDataForDomain",
    {
      type: "block-space",
      name: "space",
      spaceDomain: domain,
      requestedOnPublicDomain: true,
      showMoveTo: false,
      saveParent: false,
      shouldDuplicate: false,
      projectManagementLaunch: false,
      configureOpenInDesktopApp: false,
      mobileData: { isPush: false },
    },
  );
  // A subdomain nobody owns answers with just {"publicAccessRole":"none"}.
  if (!data?.spaceName) return { answered: ok, site: null };
  return {
    answered: true,
    site: {
      domain,
      spaceName: data.spaceName,
      homePageId: data.pageId && data.publicAccessRole !== "none" ? data.pageId : null,
    },
  };
}

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

export interface SlugCandidate {
  slug: string;
  /** True when the slug is the club's own identifier (Instagram handle, website name). */
  ownIdentifier: boolean;
}

/** Subdomains a club would plausibly pick: its Instagram handle, website name, acronym, name. */
export function notionSlugCandidates(club: { name: string; instagramHandle: string | null; websiteUrl: string | null }): SlugCandidate[] {
  const out: SlugCandidate[] = [];
  const add = (raw: string, ownIdentifier: boolean) => {
    const slug = raw.toLowerCase().replace(/[^a-z0-9-]/g, "").replace(/^-+|-+$/g, "");
    // Very short names are almost always somebody else's workspace.
    if (slug.length >= 4 && slug.length <= 32 && !out.some((c) => c.slug === slug)) out.push({ slug, ownIdentifier });
  };

  if (club.instagramHandle) {
    add(squash(club.instagramHandle), true);
  }
  if (club.websiteUrl) {
    const host = hostOf(club.websiteUrl);
    const label = host.split(".")[0];
    // Only a club's own domain counts, not a shared host like sites.google.com or wixsite.com.
    if (label && host.split(".").length === 2 && !["linktr", "notion", "google", "uwaterloo", "forms", "bit", "tinyurl", "instagram", "facebook", "discord", "wixsite", "weebly"].includes(label)) add(label, true);
  }
  const acronym = /\(([A-Za-z0-9]{2,10})\)/.exec(club.name)?.[1];
  if (acronym) {
    if (!/^uw|^wat/i.test(acronym)) add(`uw${acronym}`, false);
    add(acronym, false);
  }
  const plainName = club.name.replace(/\([^)]*\)/g, " ").replace(/,?\s*UW\s*$/i, " ");
  add(squash(plainName), false);
  if (!/^uw|waterloo/i.test(plainName.trim())) add(`uw${squash(plainName)}`, false);

  // Two guesses per club keeps a full scan to a few hundred Notion requests.
  return out.slice(0, 2);
}

const GENERIC_WORDS = new Set(["the", "and", "for", "club", "team", "association", "society", "student", "students", "university", "waterloo", "group", "design", "notion", "workspace"]);

/**
 * Does this workspace plausibly belong to the club, rather than a stranger with the same name?
 *  - its name must resemble the club (the subdomain, the acronym, or a distinctive word), and
 *  - a subdomain guessed from the club's name or acronym ("smash", "viva") must also be marked
 *    as Waterloo's; one equal to the club's own handle or domain is trusted.
 */
export function notionSiteMatchesClub(site: NotionSite, candidate: SlugCandidate, clubName: string): boolean {
  const space = squash(site.spaceName);
  const slug = squash(candidate.slug);
  const acronym = /\(([A-Za-z0-9]{3,10})\)/.exec(clubName)?.[1]?.toLowerCase();
  const words = clubName.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !GENERIC_WORDS.has(w));
  const resembles =
    space.includes(slug) || (space.length >= 3 && slug.includes(space)) || Boolean(acronym && space.includes(acronym)) || words.some((w) => space.includes(w));
  if (!resembles) return false;
  return candidate.ownIdentifier || /^(uw|wat)|waterloo/.test(slug) || /uw|waterloo/.test(space);
}

export interface NotionSearch {
  site: NotionSite | null;
  /** False when a probe went unanswered; the result should not be cached as "no site". */
  complete: boolean;
}

/** Try the candidate subdomains and return the first workspace that looks like the club's. */
export async function findNotionSite(club: { name: string; instagramHandle: string | null; websiteUrl: string | null }): Promise<NotionSearch> {
  const candidates = notionSlugCandidates(club);
  const probes = await mapLimit(candidates, 2, (c) => probeNotionSite(c.slug));
  const matches = probes
    .map((p, i) => (p.site && notionSiteMatchesClub(p.site, candidates[i], club.name) ? p.site : null))
    .filter((site): site is NotionSite => site !== null);
  // Prefer a site we can actually read.
  return { site: matches.find((s) => s.homePageId) ?? matches[0] ?? null, complete: probes.every((p) => p.answered) };
}

// ---------------------------------------------------------------------------------------------
// Reading a page
// ---------------------------------------------------------------------------------------------

export interface NotionPage {
  id: string;
  url: string;
  title: string;
  text: string;
  links: CandidateLink[];
  childPages: { id: string; title: string; url: string }[];
}

type RichText = [string, unknown[][]?][];

interface NotionBlock {
  id: string;
  type: string;
  properties?: Record<string, RichText>;
  format?: { bookmark_link?: string; display_source?: string; alias_pointer?: { id?: string } };
  parent_id?: string;
}

const dashId = (id: string) => (id.includes("-") ? id : id.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5"));

export const notionPageUrl = (domain: string, pageId: string) => `https://${domain}.notion.site/${pageId.replace(/-/g, "")}`;

/** "https://uwpm.notion.site/Exec-Apps-1a2b…32hex" → { domain: "uwpm", pageId } (pageId null for the site root). */
export function parseNotionUrl(url: string): { domain: string; pageId: string | null } | null {
  try {
    const u = new URL(url);
    const m = /^([a-z0-9-]+)\.notion\.site$/i.exec(u.hostname);
    if (!m) return null;
    const id = /([0-9a-f]{32})(?:[/?#]|$)/i.exec(u.pathname.replace(/-/g, ""))?.[1] ?? null;
    return { domain: m[1].toLowerCase(), pageId: id ? dashId(id.toLowerCase()) : null };
  } catch {
    return null;
  }
}

export function isNotionSiteUrl(url: string): boolean {
  return parseNotionUrl(url) !== null;
}

function plain(rich: RichText | undefined): string {
  return (rich ?? []).map((seg) => seg[0]).join("");
}

export async function loadNotionPage(domain: string, pageId: string): Promise<NotionPage | null> {
  const id = dashId(pageId);
  const { data } = await notionPost<{ recordMap?: { block?: Record<string, { value?: { value?: NotionBlock } | NotionBlock }> } }>(domain, "loadPageChunk", {
    pageId: id,
    limit: 100,
    cursor: { stack: [] },
    chunkNumber: 0,
    verticalColumns: false,
  });
  const records = data?.recordMap?.block;
  if (!records) return null;

  const blocks: NotionBlock[] = [];
  for (const record of Object.values(records)) {
    const outer = record.value as { value?: NotionBlock } | NotionBlock | undefined;
    const block = (outer && "value" in outer && outer.value ? outer.value : outer) as NotionBlock | undefined;
    if (block?.id && block.type) blocks.push(block);
  }
  const root = blocks.find((b) => b.id === id);
  if (!root) return null;

  const base = `https://${domain}.notion.site/`;
  const links: CandidateLink[] = [];
  const childPages: NotionPage["childPages"] = [];
  const textParts: string[] = [];

  for (const block of blocks) {
    if (block.id === id) continue;
    const title = plain(block.properties?.title).trim();

    if (block.type === "page" || block.type === "collection_view_page") {
      // Sub-pages and database rows.
      if (title) childPages.push({ id: block.id, title, url: notionPageUrl(domain, block.id) });
      continue;
    }
    if (title) textParts.push(title);

    // Inline links: a segment's annotations hold ["a", url]; ["p", id] is a page mention.
    for (const rich of Object.values(block.properties ?? {})) {
      if (!Array.isArray(rich)) continue;
      for (const seg of rich) {
        for (const ann of seg[1] ?? []) {
          if (ann[0] === "a" && typeof ann[1] === "string") {
            try {
              links.push({ title: seg[0].trim() || title, url: new URL(ann[1], base).toString(), context: title.slice(0, 240) });
            } catch {
              // malformed href
            }
          }
        }
      }
    }
    // Bookmark and embed blocks keep their target in properties.link / properties.source.
    for (const key of ["link", "source"] as const) {
      const target = plain(block.properties?.[key]);
      if (/^https?:\/\//.test(target) && !/\.(png|jpe?g|gif|webp|svg)(\?|$)/i.test(target) && block.type !== "image") {
        links.push({ title: title || plain(block.properties?.description) || "", url: target, context: title.slice(0, 240) });
      }
    }
  }

  return {
    id,
    url: notionPageUrl(domain, id),
    title: plain(root.properties?.title).trim(),
    text: textParts.join(" ").replace(/\s+/g, " ").slice(0, 4000),
    links,
    childPages,
  };
}

const HIRING_PAGE_TITLE = /\b(join|appl(y|ication|ications)|apps|recruit\w*|hiring|exec\w*|director|positions?|roles?|opportunit\w*|get involved|team|careers?|volunteer)\b/i;

export interface NotionScrape {
  pages: NotionPage[];
  candidates: CandidateLink[];
}

/**
 * Read a public Notion page plus up to four hiring-looking sub-pages, and return everything on
 * them that could be an application: outbound links, and the sub-pages themselves.
 */
export async function scrapeNotionPages(domain: string, pageId: string): Promise<NotionScrape | null> {
  const home = await loadNotionPage(domain, pageId);
  if (!home) return null;

  const follow = home.childPages.filter((p) => HIRING_PAGE_TITLE.test(p.title)).slice(0, 4);
  const subPages = (await mapLimit(follow, 2, (p) => loadNotionPage(domain, p.id))).filter((p): p is NotionPage => p !== null);
  const pages = [home, ...subPages];

  const candidates: CandidateLink[] = [];
  for (const page of pages) {
    // The page itself counts when its title reads like an application ("F26 Exec Applications").
    candidates.push({ title: page.title, url: page.url, context: page.text.slice(0, 400) });
    for (const link of page.links) candidates.push({ ...link, context: `${page.title} ${link.context ?? ""}`.trim().slice(0, 240) });
    for (const child of page.childPages) candidates.push({ title: child.title, url: child.url, context: page.title });
  }
  return { pages, candidates };
}
