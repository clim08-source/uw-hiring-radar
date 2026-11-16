// Small fetch helpers shared by discovery and scraping.

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const MAX_BODY_CHARS = 2_000_000;

export interface PageResult {
  ok: boolean;
  status: number; // 0 = network error / timeout
  finalUrl: string;
  text: string;
}

export interface FetchOptions {
  timeoutMs?: number;
  method?: "GET" | "POST";
  body?: string;
  headers?: Record<string, string>;
  /** Send a plain, non-browser User-Agent (some short-link hosts only redirect for those). */
  plainUserAgent?: boolean;
}

export function isHttpUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export async function fetchPage(url: string, opts: FetchOptions = {}): Promise<PageResult> {
  if (!isHttpUrl(url)) return { ok: false, status: 0, finalUrl: url, text: "" };
  try {
    const res = await fetch(url, {
      method: opts.method ?? "GET",
      body: opts.body,
      redirect: "follow",
      signal: AbortSignal.timeout(opts.timeoutMs ?? 12_000),
      headers: {
        "User-Agent": opts.plainUserAgent ? "Mozilla/5.0 (compatible; UWHiringRadar/1.0)" : USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-CA,en;q=0.9",
        ...opts.headers,
      },
    });
    const text = (await res.text()).slice(0, MAX_BODY_CHARS);
    return { ok: res.ok, status: res.status, finalUrl: res.url || url, text };
  } catch {
    return { ok: false, status: 0, finalUrl: url, text: "" };
  }
}

/** Run `fn` over `items` with at most `limit` in flight. Results keep input order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

export function hostMatches(url: string, hosts: string[]): boolean {
  const host = hostOf(url);
  return hosts.some((h) => host === h || host.endsWith(`.${h}`));
}

/** Strip tracking params and trailing slashes so the same link dedupes across scrapes. */
export function normalizeUrl(raw: string, base?: string): string | null {
  try {
    const u = new URL(raw, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    for (const key of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|igshid|igsh|ref$|usp$|pli$)/i.test(key)) u.searchParams.delete(key);
    }
    let out = u.toString();
    if (u.pathname !== "/" && out.endsWith("/")) out = out.slice(0, -1);
    return out;
  } catch {
    return null;
  }
}
