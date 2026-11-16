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

If an LLM call fails, that club falls back to the keyword classifier. Whatever the model says, a link whose named term has already ended is dropped by a deterministic check.

## How the pipeline works

`POST /api/scrape` starts a run in the background; `GET /api/scrape` reports progress.

1. **Discovery** — `lib/discovery.ts`
   - **WUSA clubs** (`clubs.wusa.ca`): the directory is a JavaScript app, so club pages are read through the public JSON endpoints the page itself calls (`/api/v1/clubs_listing/active`, `/api/v1/clubs/[id]/profile`) for name, categories, Instagram handle and website / Linktree links.
   - **Design teams**: the Sedra directory page and each team page are parsed with `cheerio` for the team's site and socials.
   - **Link-in-bio resolution**: a known Linktree / Beacons / Carrd link → a link-in-bio or `/join` / `/apply` link in the club site's header, nav or footer → `linktr.ee/<instagram handle>` when that page verifiably belongs to the club → the club website.
2. **Scrape** — `lib/scraper.ts` reads Linktree's `<script id="__NEXT_DATA__">` JSON and standard `<a>` tags, and follows up to two same-site apply pages on club websites.
3. **Classify** — `lib/classifier.ts` gets the links and today's date. It understands `F26` / `Fall 2026` / `W27` / `S27`, "Exec Apps", "Subteam Recruiting", "Director Applications", and drops Discord, merch, sponsorship packages, events and expired terms. Term logic lives in `lib/terms.ts`.
4. **Verify** — each hiring link is fetched. Google Forms, Typeform, Tally and Jotform are checked for a "no longer accepting responses" notice.

Each opportunity ends up with one of three statuses:

| Status | Meaning |
| --- | --- |
| `OPEN` | The form was fetched and is accepting responses |
| `UNVERIFIED` | Listed on the club's page, but the state can't be confirmed (sign-in-only Google Forms, Microsoft Forms, Airtable, plain web pages) |
| `CLOSED` | The form says it is closed, the link is dead, or it disappeared from the club's page |

## Known limits

- Instagram bios can't be read without logging in, so a Linktree is only found when the club lists it on WUSA, on its website, or under its Instagram handle on Linktree.
- The keyword classifier treats membership and interest sign-up forms as low-confidence "General" opportunities and will sometimes let an event sign-up through. An LLM key improves this.
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
