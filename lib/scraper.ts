// Link-in-bio scraper: extracts links from Linktree / Beacons / Carrd / plain club pages,
// classifies them, and verifies that application forms are still accepting responses.

import * as cheerio from "cheerio";
import { classifyLinks, isFormUrl, type CandidateLink, type ClassifiedLink } from "./classifier";
import { isLinkInBioUrl } from "./discovery";
import { fetchPage, hostMatches, hostOf, mapLimit, normalizeUrl } from "./http";
import { extractDeadline, pickTargetTerm } from "./terms";

export interface ScrapedPage {
  ok: boolean;
  url: string;
  kind: "linktree" | "link-in-bio" | "website";
  title: string | null;
  text: string;
  links: CandidateLink[];
}

const APPLY_PATH = /\/(join|join-us|joinus|join-our-team|join-the-team|apply|applications?|recruit(ment|ing)?|careers?|jobs?|hiring|get-involved|getinvolved|opportunities|positions)(\/|$|\?)/i;

// ---------------------------------------------------------------------------------------------
// Link extraction
// ---------------------------------------------------------------------------------------------

/** Linktree embeds the whole page model in <script id="__NEXT_DATA__">. */
function linksFromLinktree(nextData: unknown): CandidateLink[] {
  const pageProps = (nextData as { props?: { pageProps?: Record<string, unknown> } })?.props?.pageProps ?? {};
  const out: CandidateLink[] = [];
  const push = (title: unknown, url: unknown) => {
    if (typeof url === "string" && url) out.push({ title: typeof title === "string" ? title : "", url });
  };
  const walk = (items: unknown) => {
    if (!Array.isArray(items)) return;
    for (const item of items as Record<string, unknown>[]) {
      if (!item || typeof item !== "object") continue;
      if (item.locked) continue;
      push(item.title, item.url);
      // Linktree "groups" nest their children.
      walk(item.links);
      walk(item.children);
    }
  };
  walk(pageProps.links);
  walk(pageProps.pinnedLinks);
  for (const s of (pageProps.socialLinks as Record<string, unknown>[] | undefined) ?? []) push(s?.type, s?.url);
  return out;
}

/** Generic walk for other Next.js / JSON-driven bio pages: any object with a url and a label. */
function linksFromJson(node: unknown, out: CandidateLink[] = [], depth = 0): CandidateLink[] {
  if (depth > 12 || node === null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const item of node) linksFromJson(item, out, depth + 1);
    return out;
  }
  const obj = node as Record<string, unknown>;
  const url = [obj.url, obj.href, obj.link, obj.destination].find((v) => typeof v === "string" && /^https?:\/\//.test(v as string));
  const title = [obj.title, obj.label, obj.name, obj.text, obj.heading].find((v) => typeof v === "string" && (v as string).trim());
  if (url && title) out.push({ title: String(title), url: String(url) });
  for (const value of Object.values(obj)) linksFromJson(value, out, depth + 1);
  return out;
}

function dedupe(links: CandidateLink[], base: string): CandidateLink[] {
  const seen = new Map<string, CandidateLink>();
  for (const link of links) {
    const url = normalizeUrl(link.url, base);
    if (!url) continue;
    const title = link.title.replace(/\s+/g, " ").trim();
    const existing = seen.get(url);
    // Keep the most descriptive label for a URL.
    if (!existing || title.length > existing.title.length) seen.set(url, { ...link, url, title });
  }
  return [...seen.values()];
}

export async function scrapeLinkPage(url: string): Promise<ScrapedPage> {
  const page = await fetchPage(url);
  const kind: ScrapedPage["kind"] = hostMatches(url, ["linktr.ee"]) ? "linktree" : isLinkInBioUrl(url) ? "link-in-bio" : "website";
  if (!page.ok) return { ok: false, url, kind, title: null, text: "", links: [] };

  const $ = cheerio.load(page.text);
  const links: CandidateLink[] = [];

  const nextDataRaw = $("script#__NEXT_DATA__").first().html();
  if (nextDataRaw) {
    try {
      const nextData = JSON.parse(nextDataRaw);
      links.push(...(kind === "linktree" ? linksFromLinktree(nextData) : linksFromJson(nextData)));
    } catch {
      // fall through to <a> tags
    }
  }

  // Standard <a> tags (Carrd, Beacons, club websites). Skipped for a Linktree whose JSON parsed:
  // its markup adds Linktree's own footer and "featured creator" links, which are not the club's.
  const useAnchors = !(kind === "linktree" && links.length > 0);
  $(useAnchors ? "a[href]" : "a[data-none]").each((_, el) => {
    const href = $(el).attr("href") ?? "";
    if (!href || href.startsWith("#") || href.startsWith("javascript:")) return;
    const title =
      $(el).text().replace(/\s+/g, " ").trim() || $(el).attr("aria-label") || $(el).attr("title") || $(el).find("img").attr("alt") || "";
    // A sentence or two around the link helps spot terms and deadlines on club websites.
    const context = kind === "website" ? $(el).parent().text().replace(/\s+/g, " ").trim().slice(0, 240) : undefined;
    links.push({ title, url: href, context });
  });

  $("script, style, noscript").remove();
  const text = $("body").text().replace(/\s+/g, " ").trim().slice(0, 4000);
  const title = $("title").first().text().trim() || $("h1").first().text().trim() || null;

  return { ok: true, url: page.finalUrl, kind, title, text, links: dedupe(links, page.finalUrl) };
}

// ---------------------------------------------------------------------------------------------
// Form verification
// ---------------------------------------------------------------------------------------------

export type FormState = "OPEN" | "CLOSED" | "UNVERIFIED";

export interface FormCheck {
  state: FormState;
  provider: string;
  title: string | null;
  detail: string;
}

const CLOSED_TEXT =
  /no longer accepting responses|not accepting responses|isn['’]t accepting (new )?responses|this (type)?form is (now )?closed|form (is|has been) (now )?closed|this form is no longer accepting|no longer accepting (submissions|applications)|applications? (are|have|is) (now |currently )?closed|submissions? (are|have been) closed|form is currently closed|this form is not currently accepting|form you are trying to access is no longer available/i;

function providerOf(url: string): string {
  if (hostMatches(url, ["docs.google.com", "forms.gle"])) return "google-forms";
  if (hostMatches(url, ["typeform.com"])) return "typeform";
  if (hostMatches(url, ["airtable.com"])) return "airtable";
  if (hostMatches(url, ["tally.so"])) return "tally";
  if (hostMatches(url, ["forms.office.com", "forms.microsoft.com", "forms.cloud.microsoft"])) return "microsoft-forms";
  if (hostMatches(url, ["jotform.com"])) return "jotform";
  if (hostMatches(url, ["notion.site", "notion.so"])) return "notion";
  if (hostMatches(url, ["fillout.com"])) return "fillout";
  return "web";
}

/** Fetch an application link and decide whether it still accepts responses. */
export async function verifyForm(url: string): Promise<FormCheck> {
  const provider = providerOf(url);
  let page = await fetchPage(url, { timeoutMs: 15_000 });
  // forms.gle shows browsers an app deep-link interstitial instead of redirecting to the form.
  if (page.ok && hostMatches(page.finalUrl, ["forms.gle"])) {
    page = await fetchPage(page.finalUrl, { timeoutMs: 15_000, plainUserAgent: true });
  }

  if (page.status === 404 || page.status === 410) {
    return { state: "CLOSED", provider, title: null, detail: `link returns HTTP ${page.status}` };
  }
  if ((page.status === 401 || page.status === 403) && provider === "google-forms") {
    // Closed Google Forms still load; a 401 means the form wants a sign-in (often @uwaterloo.ca only).
    return { state: "UNVERIFIED", provider, title: null, detail: "form requires a Google sign-in, so its state can't be checked" };
  }
  if (!page.ok) {
    return { state: "UNVERIFIED", provider, title: null, detail: page.status ? `HTTP ${page.status}` : "could not reach link" };
  }

  const finalProvider = providerOf(page.finalUrl) === "web" ? provider : providerOf(page.finalUrl);
  const $ = cheerio.load(page.text);
  const title =
    $("meta[property='og:title']").attr("content")?.trim() || $("title").first().text().trim().replace(/\s*[-–|]\s*Google Forms$/i, "") || null;
  $("script, style, noscript").remove();
  const text = $("body").text().replace(/\s+/g, " ");

  if (/\/closedform/i.test(page.finalUrl) || CLOSED_TEXT.test(text)) {
    return { state: "CLOSED", provider: finalProvider, title, detail: "form says it is no longer accepting responses" };
  }

  if (finalProvider === "google-forms") {
    // A sign-in wall means the form is restricted (often to @uwaterloo.ca), not closed.
    if (hostMatches(page.finalUrl, ["accounts.google.com"])) {
      return { state: "UNVERIFIED", provider: finalProvider, title: null, detail: "form requires a Google sign-in" };
    }
    if (/formResponse|freebirdFormviewer|FB_PUBLIC_LOAD_DATA_/.test(page.text)) {
      return { state: "OPEN", provider: finalProvider, title, detail: "Google Form is accepting responses" };
    }
    return { state: "UNVERIFIED", provider: finalProvider, title, detail: "could not confirm form state" };
  }

  if (finalProvider === "typeform" || finalProvider === "tally" || finalProvider === "jotform" || finalProvider === "fillout") {
    // These server-render their closed notice, so a page without one is treated as live.
    return { state: "OPEN", provider: finalProvider, title, detail: "form loads with no closed notice" };
  }

  if (finalProvider === "microsoft-forms" || finalProvider === "airtable") {
    return { state: "UNVERIFIED", provider: finalProvider, title, detail: "form renders client-side; open / closed state unknown" };
  }

  return { state: "UNVERIFIED", provider: finalProvider, title, detail: "page loads; not a recognised form provider" };
}

// ---------------------------------------------------------------------------------------------
// Club scrape: page → candidates → classify → verify
// ---------------------------------------------------------------------------------------------

export interface FoundOpportunity {
  title: string;
  url: string;
  targetTerm: string | null;
  roleType: string;
  status: FormState;
  formProvider: string;
  deadline: Date | null;
  confidence: number;
  classifier: string;
  reason: string;
}

export interface ClubScrapeResult {
  reachable: boolean;
  scrapedUrl: string;
  linksSeen: number;
  opportunities: FoundOpportunity[];
}

const GENERIC_TITLE = /^(apply|apply here|apply now|click here|here|link|form|application|applications|join|join us|join now|sign up|learn more.*|(view )?details.*|read more)$/i;

/** "/jobs/chemistry-team-lab" → "Chemistry Team Lab" */
function titleFromSlug(url: string): string | null {
  try {
    const slug = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "";
    if (!/[a-z]{3,}/i.test(slug) || APPLY_PATH.test(`/${slug}`)) return null;
    return slug.replace(/\.[a-z]+$/i, "").replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  } catch {
    return null;
  }
}

export async function scrapeClubLinks(clubName: string, targetUrl: string, now: Date = new Date()): Promise<ClubScrapeResult> {
  const page = await scrapeLinkPage(targetUrl);
  if (!page.ok) return { reachable: false, scrapedUrl: targetUrl, linksSeen: 0, opportunities: [] };

  let candidates = page.links;

  if (page.kind === "website") {
    const siteHost = hostOf(page.url);
    // Follow up to two same-site join / apply pages and collect their links too.
    const applyPages = candidates.filter((l) => hostOf(l.url) === siteHost && APPLY_PATH.test(l.url) && l.url !== normalizeUrl(page.url)).slice(0, 2);
    const subPages = await mapLimit(applyPages, 2, (l) => scrapeLinkPage(l.url));
    const extra: CandidateLink[] = [];
    for (const sub of subPages) {
      if (!sub.ok) continue;
      extra.push(...sub.links.map((l) => ({ ...l, context: l.context ?? sub.text.slice(0, 240) })));
    }
    // On a club website only off-site links and forms are application candidates; skip site nav.
    // Same-site apply / job pages are kept too, except the page we are already on.
    const selfUrl = normalizeUrl(page.url);
    candidates = [...candidates, ...extra].filter(
      (l) => hostOf(l.url) !== siteHost || isFormUrl(l.url) || (APPLY_PATH.test(l.url) && l.url !== selfUrl && l.url !== normalizeUrl(targetUrl)),
    );
    const seen = new Set<string>();
    candidates = candidates.filter((l) => (seen.has(l.url) ? false : (seen.add(l.url), true)));
  }

  const classified = await classifyLinks(clubName, candidates, now);
  const hiring = classified.filter((c) => c.isHiring && c.confidence >= 0.5);

  const opportunities = await mapLimit(hiring, 3, async (link: ClassifiedLink): Promise<FoundOpportunity> => {
    const check = await verifyForm(link.url);
    let title = link.title;
    if (!title || GENERIC_TITLE.test(title)) {
      const sameSite = hostOf(link.url) === hostOf(page.url);
      title = (sameSite ? titleFromSlug(link.url) : check.title) ?? title;
    }
    if (!title) title = "Application";
    return {
      title: title.slice(0, 140),
      url: link.url,
      targetTerm: link.targetTerm,
      roleType: link.roleType,
      status: check.state,
      formProvider: check.provider,
      deadline: extractDeadline(`${link.title} ${link.context ?? ""} ${check.title ?? ""}`, now),
      confidence: link.confidence,
      classifier: link.classifier,
      reason: `${link.reason} · ${check.detail}`,
    };
  });

  // A club's own /join or /apply page with no outbound form is itself the opportunity,
  // unless its copy says recruitment is closed or only names past terms.
  if (opportunities.length === 0 && page.kind === "website" && APPLY_PATH.test(page.url)) {
    const { term, onlyExpired } = pickTargetTerm(page.text, now);
    const closed = CLOSED_TEXT.test(page.text) || /\b(applications? (are|have) (now |currently )?closed|not (currently )?(recruiting|hiring)|check back|recruitment (is|has) (now )?(closed|ended))\b/i.test(page.text);
    if (!closed && !onlyExpired) {
      opportunities.push({
        title: (page.title ?? `Join ${clubName}`).slice(0, 140),
        url: normalizeUrl(page.url) ?? page.url,
        targetTerm: term?.code ?? null,
        roleType: "GENERAL",
        status: "UNVERIFIED",
        formProvider: "web",
        deadline: extractDeadline(page.text, now),
        confidence: term ? 0.6 : 0.5,
        classifier: "keyword",
        reason: "club's own join / apply page; no closed notice found",
      });
    }
  }

  return { reachable: true, scrapedUrl: page.url, linksSeen: candidates.length, opportunities };
}
