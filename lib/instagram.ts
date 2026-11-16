// Step B — Instagram bio link extraction without logging in to Instagram.
//
//  Primary:  APIFY_API_TOKEN  → runs the `apify/instagram-profile-scraper` actor over the whole
//            batch of handles and reads each profile's biography, externalUrl and externalUrls.
//  Fallback: SERPER_API_KEY   → a Google search for `site:instagram.com/{handle}` per handle; the
//            result snippet usually carries the bio text, from which link-like strings are pulled.
//  Neither:  no bio data; the pipeline falls back to the club's website from WUSA / Sedra.
//
// Nothing here talks to instagram.com directly, so there is no account to get banned.

import { mapLimit, normalizeUrl } from "./http";

export type BioSource = "apify" | "serper";

export interface InstagramBio {
  handle: string;
  source: BioSource;
  biography: string | null;
  /** Every link found for the profile, deduped, most specific first. */
  links: string[];
}

export function activeBioSource(): BioSource | null {
  if (process.env.APIFY_API_TOKEN) return "apify";
  if (process.env.SERPER_API_KEY) return "serper";
  return null;
}

// ---------------------------------------------------------------------------------------------
// Link clean-up shared by both sources
// ---------------------------------------------------------------------------------------------

/** Instagram wraps outbound links as https://l.instagram.com/?u=<encoded target>&e=… */
export function unwrapInstagramLink(raw: string): string {
  try {
    const u = new URL(raw);
    if (/^l\.instagram\.com$/i.test(u.hostname)) {
      const target = u.searchParams.get("u");
      if (target) return target;
    }
  } catch {
    // not a URL; returned as-is
  }
  return raw;
}

// Hosts worth lifting out of free bio text even when written without "https://".
const BARE_LINK =
  /(?:https?:\/\/)?(?:www\.)?(?:linktr\.ee|beacons\.ai|bio\.link|lnk\.bio|campsite\.bio|linkin\.bio|taplink\.cc|forms\.gle|docs\.google\.com\/forms|tinyurl\.com|bit\.ly|typeform\.com|[a-z0-9-]+\.typeform\.com|airtable\.com|tally\.so|[a-z0-9-]+\.carrd\.co|[a-z0-9-]+\.notion\.site)\/?[^\s"'<>)\]]*/gi;
const FULL_URL = /https?:\/\/[^\s"'<>)\]]+/gi;

/** Pull links out of bio text: full URLs plus bare "linktr.ee/club"-style mentions. */
export function extractLinksFromText(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(FULL_URL)) found.push(m[0]);
  for (const m of text.matchAll(BARE_LINK)) found.push(/^https?:\/\//i.test(m[0]) ? m[0] : `https://${m[0]}`);
  return found.map((u) => u.replace(/[.,;:!…]+$/, ""));
}

function cleanLinks(raw: (string | null | undefined)[]): string[] {
  const out: string[] = [];
  for (const item of raw) {
    if (!item) continue;
    const url = normalizeUrl(unwrapInstagramLink(item.trim()).replace(/^(?!https?:\/\/)/i, "https://"));
    // Links back to Instagram itself are never a bio destination.
    if (!url || /(^|\.)instagram\.com$/i.test(new URL(url).hostname)) continue;
    if (!out.includes(url)) out.push(url);
  }
  return out.slice(0, 8);
}

// ---------------------------------------------------------------------------------------------
// Primary: Apify actor apify/instagram-profile-scraper (REST API v2)
// ---------------------------------------------------------------------------------------------

const APIFY_BASE = "https://api.apify.com/v2";
const APIFY_ACTOR = "apify~instagram-profile-scraper";
const APIFY_MAX_WAIT_MS = 12 * 60 * 1000;

interface ApifyProfile {
  username?: string;
  biography?: string | null;
  externalUrl?: string | null;
  // The actor's output names this array `externalUrls`; `bioLinks` is accepted too.
  externalUrls?: { title?: string; url?: string; lynx_url?: string }[] | null;
  bioLinks?: ({ title?: string; url?: string; lynx_url?: string } | string)[] | null;
}

export function bioFromApifyProfile(profile: ApifyProfile): InstagramBio | null {
  if (!profile.username) return null;
  const listed = [...(profile.externalUrls ?? []), ...(profile.bioLinks ?? [])].map((l) => (typeof l === "string" ? l : (l.url ?? l.lynx_url)));
  const biography = profile.biography?.trim() || null;
  return {
    handle: profile.username.toLowerCase(),
    source: "apify",
    biography,
    links: cleanLinks([...listed, profile.externalUrl, ...extractLinksFromText(biography ?? "")]),
  };
}

async function apifyFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${APIFY_BASE}${path}`, {
    ...init,
    // The token goes in a header, never in the URL.
    headers: { Authorization: `Bearer ${process.env.APIFY_API_TOKEN}`, "Content-Type": "application/json", ...init.headers },
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new Error(`Apify ${path.split("?")[0]} returned HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** Run the actor over the whole batch, wait for it to finish, and read its dataset. */
async function fetchBiosWithApify(handles: string[]): Promise<InstagramBio[]> {
  type Run = { data: { id: string; status: string; defaultDatasetId: string } };
  let run = await apifyFetch<Run>(`/actors/${APIFY_ACTOR}/runs?waitForFinish=60`, {
    method: "POST",
    body: JSON.stringify({ usernames: handles }),
  });

  const deadline = Date.now() + APIFY_MAX_WAIT_MS;
  while (run.data.status === "READY" || run.data.status === "RUNNING") {
    if (Date.now() > deadline) throw new Error("Apify run did not finish in time");
    run = await apifyFetch<Run>(`/actor-runs/${run.data.id}?waitForFinish=60`);
  }
  if (run.data.status !== "SUCCEEDED") throw new Error(`Apify run ended with status ${run.data.status}`);

  const items = await apifyFetch<ApifyProfile[]>(`/datasets/${run.data.defaultDatasetId}/items?clean=true&format=json`);
  return items.map(bioFromApifyProfile).filter((b): b is InstagramBio => b !== null);
}

// ---------------------------------------------------------------------------------------------
// Fallback: Serper (Google search results for the profile page)
// ---------------------------------------------------------------------------------------------

interface SerperResponse {
  organic?: { title?: string; link?: string; snippet?: string }[];
}

export function bioFromSerperResponse(handle: string, data: SerperResponse): InstagramBio | null {
  const profilePath = new RegExp(`instagram\\.com/${handle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/?(\\?|$)`, "i");
  // Only the profile page itself carries the bio; posts and reels are other accounts' text.
  const hits = (data.organic ?? []).filter((r) => r.link && profilePath.test(r.link));
  if (hits.length === 0) return null;
  const text = hits.map((r) => `${r.title ?? ""} ${r.snippet ?? ""}`).join(" ");
  return { handle, source: "serper", biography: hits[0].snippet?.trim() || null, links: cleanLinks(extractLinksFromText(text)) };
}

async function fetchBioWithSerper(handle: string): Promise<InstagramBio | null> {
  const res = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: { "X-API-KEY": process.env.SERPER_API_KEY ?? "", "Content-Type": "application/json" },
    body: JSON.stringify({ q: `site:instagram.com/${handle}`, num: 5 }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Serper returned HTTP ${res.status}`);
  return bioFromSerperResponse(handle, (await res.json()) as SerperResponse);
}

// ---------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------

export interface BioBatchResult {
  source: BioSource | null;
  /** Keyed by lower-case handle. Handles with no result are absent. */
  bios: Map<string, InstagramBio>;
  error: string | null;
}

/** Extract bio links for a batch of handles using whichever source is configured. */
export async function fetchInstagramBios(handles: string[]): Promise<BioBatchResult> {
  const unique = [...new Set(handles.map((h) => h.replace(/^@/, "").toLowerCase()).filter(Boolean))];
  const source = activeBioSource();
  const bios = new Map<string, InstagramBio>();
  if (!source || unique.length === 0) return { source, bios, error: null };

  try {
    if (source === "apify") {
      for (const bio of await fetchBiosWithApify(unique)) bios.set(bio.handle, bio);
    } else {
      let failures = 0;
      let lastError = "";
      await mapLimit(unique, 4, async (handle) => {
        try {
          const bio = await fetchBioWithSerper(handle);
          if (bio) bios.set(handle, bio);
        } catch (err) {
          failures += 1;
          lastError = (err as Error).message;
        }
      });
      if (failures > 0) return { source, bios, error: `${failures} of ${unique.length} Serper lookups failed (${lastError})` };
    }
    return { source, bios, error: null };
  } catch (err) {
    return { source, bios, error: (err as Error).message };
  }
}
