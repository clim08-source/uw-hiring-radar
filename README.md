# UW Hiring Radar

A live feed of University of Waterloo club and student design team applications, plus a Bento-grid tracker for your own applications.

It discovers clubs from the WUSA Clubs Directory and the Sedra Student Design Centre, finds each one's link-in-bio page (Linktree, Beacons, Carrd, or a `/join` / `/apply` page), classifies the links with a UW-term-aware classifier, and checks that application forms are still accepting responses.

## Quick start

```bash
npm install
npm run dev
```

Open http://localhost:3000 and press **Scan clubs now**. `npm run dev` creates the SQLite database (`prisma/dev.db`) on first run — there is nothing to configure.

A full scan covers about 250 clubs and teams and takes a few minutes. You can also run it from the terminal:

```bash
npm run scrape                  # discover + scrape everything
npm run scrape -- --limit 10    # quick run: 10 clubs per source
npm run scrape -- --skip-discovery
```

## Optional: LLM classification

Copy `.env.example` to `.env` and set one key. Without a key the app uses its regex / keyword classifier.

| Variable | Effect |
| --- | --- |
| `GEMINI_API_KEY` | Classify with Gemini via `@google/genai` (`GEMINI_MODEL` overrides the model) |
| `OPENAI_API_KEY` | Classify with OpenAI via `openai` (`OPENAI_MODEL` overrides the model) |
| `APIFY_API_TOKEN` | Read Instagram bio links through Apify (uses your Apify credits) |
| `SERPER_API_KEY` | Fallback for bio links: one serper.dev search per Instagram handle |

If an LLM call fails, that club falls back to the keyword classifier. Whatever the model says, a link whose named term has already ended is dropped by a deterministic check.

## How the pipeline works

`POST /api/scrape` starts a run in the background; `GET /api/scrape` reports progress.

1. **Discovery** — `lib/discovery.ts`
   - **WUSA clubs** (`clubs.wusa.ca`): the directory is a JavaScript app, so club pages are read through the public JSON endpoints the page itself calls (`/api/v1/clubs_listing/active`, `/api/v1/clubs/[id]/profile`) for name, categories, Instagram handle and website / Linktree links.
   - **Design teams**: the Sedra directory page and each team page are parsed with `cheerio` for the team's site and socials.
   - **Link-in-bio resolution**: a known Linktree / Beacons / Carrd link → a link-in-bio or `/join` / `/apply` link in the club site's header, nav or footer → `linktr.ee/<instagram handle>` when that page verifiably belongs to the club → the club website.
   - **Instagram bio links** — `lib/instagram.ts`, no Instagram login involved:
     - `APIFY_API_TOKEN` set: one run of the `apify/instagram-profile-scraper` actor over every club handle, reading `biography`, `externalUrl` and `externalUrls`.
     - otherwise `SERPER_API_KEY` set: one Google search per handle (`site:instagram.com/{handle}`), pulling links such as `linktr.ee/club` or `forms.gle/…` out of the result snippet.
     - neither set: skipped; the club's website or Linktree from WUSA / Sedra is used.
     Bios are refreshed at most every 20 hours per club.
   - **Notion sites**: `lib/notion.ts` also guesses `<clubname>.notion.site` from the club's Instagram handle, website name, acronym and name (two guesses per club), and keeps a match only when the workspace name resembles the club. The search is repeated at most weekly per club.
2. **Destinations** — every bio link (up to four per club) goes through `scrapeDestination` in `lib/scraper.ts`, which handles the four common cases: a **direct form** (the form itself is the application; its title is read and it is checked for a closed notice), a **link-in-bio page**, a **public Notion page**, or a **club website** (homepage links plus `/apply`, `/join`, `/recruitment`, `/hiring` pages). Short links (`tinyurl.com`, `bit.ly`) are followed first.
   **Scrape details** — `lib/scraper.ts` reads Linktree's `<script id="__NEXT_DATA__">` JSON and standard `<a>` tags, and follows up to two same-site apply pages on club websites. Notion pages render in the browser, so they are read through Notion's public page API: the page's links, plus up to four sub-pages whose titles look like hiring ("Exec Applications", "Join the team").
3. **Classify** — `lib/classifier.ts` gets the links and today's date. It understands `F26` / `Fall 2026` / `W27` / `S27`, "Exec Apps", "Subteam Recruiting", "Director Applications", and drops Discord, merch, sponsorship packages, events and expired terms. Term logic lives in `lib/terms.ts`.
4. **Verify** — each hiring link is fetched. Google Forms, Typeform, Tally and Jotform are checked for a "no longer accepting responses" notice.

Each opportunity ends up with one of three statuses:

| Status | Meaning |
| --- | --- |
| `OPEN` | The form was fetched and is accepting responses |
| `UNVERIFIED` | Listed on the club's page, but the state can't be confirmed (sign-in-only Google Forms, Microsoft Forms, Airtable, plain web pages) |
| `CLOSED` | The form says it is closed, the link is dead, or it disappeared from the club's page |

## Known limits

- Instagram bios are only read when `APIFY_API_TOKEN` or `SERPER_API_KEY` is set. Without either, a Linktree is only found when the club lists it on WUSA, on its website, or under its Instagram handle on Linktree. The Serper route sees only what Google shows in its snippet, so it misses links Instagram keeps out of the bio text.
- The keyword classifier treats membership and interest sign-up forms as low-confidence "General" opportunities and will sometimes let an event sign-up through. An LLM key improves this.
- Notion only reveals a workspace's public *home* page. Many clubs have a workspace at `<clubname>.notion.site` with no public home page; those are recorded but nothing can be read from them. A club's individually shared Notion pages are only found when the club links to them.
- Notion rate-limits bursts. Requests are sent about one per second, so the first scan after install spends several minutes on Notion lookups, and a rate-limit response pauses Notion lookups for 20 minutes (the scan carries on without them).
- Beacons pages that render entirely client-side yield few links.

## API

| Route | Methods | Purpose |
| --- | --- | --- |
| `/api/scrape` | `GET`, `POST` | Run status and stats; start a run (`{ "limit": 10, "sources": ["WUSA"], "skipDiscovery": false }`, all optional) |
| `/api/opportunities` | `GET` | Hiring feed (`?includeClosed=1`) |
| `/api/clubs` | `GET`, `POST` | List clubs; add a custom club `{ "name", "url" }` and scrape it |
| `/api/tracker` | `GET`, `POST` | Tracked applications; add from the feed `{ "opportunityId" }` or manually |
| `/api/tracker/[id]` | `PATCH`, `DELETE` | Change stage / notes / deadline; remove |

## Data model

`prisma/schema.prisma` defines `Club`, `ApplicationOpportunity`, `TrackedApplication` and `ScrapeRun`. Browse the data with `npm run db:studio`.

## Publishing to GitHub

```bash
gh auth login                           # once
npm run publish:github                  # private repo named after this folder
npm run publish:github -- my-repo --public
```

The script initialises git if needed, commits, creates the repository with `gh repo create` and pushes. `.env`, `node_modules`, `.next` and `prisma/dev.db` are gitignored, and the script refuses to push if `.env` or the database is tracked.

## Stack

Next.js (App Router) · TypeScript · Tailwind CSS · Lucide icons · Prisma + SQLite · cheerio · `@google/genai` / `openai`
