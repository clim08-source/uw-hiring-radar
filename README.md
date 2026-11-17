# UW Hiring Radar

A live feed of University of Waterloo club and student design team applications, with a Bento-grid tracker for your own applications.

It discovers clubs from the WUSA Clubs Directory and the Sedra Student Design Centre, reads each club's Instagram bio links and link-in-bio page, works out which links are active applications for the current or upcoming term, and checks whether the forms are still accepting responses.

## Contents

- [Who it is for](#who-it-is-for)
- [What you can do](#what-you-can-do)
- [Scope](#scope)
- [Tech stack](#tech-stack)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Deploying to Vercel](#deploying-to-vercel)
- [How the pipeline works](#how-the-pipeline-works)
- [Project structure](#project-structure)
- [API](#api)
- [Data model](#data-model)
- [Known limits](#known-limits)
- [Scripts](#scripts)

## Who it is for

**University of Waterloo students looking to join a club or design team** — especially for exec, director and subteam roles, which are posted for a few weeks each term across hundreds of separate Instagram bios and Linktrees.

It is built as a personal tool: one person (or a small group who trust each other) runs it and uses it. It has no accounts or logins.

## What you can do

- **Browse a live hiring feed** of open applications across about 250 clubs and design teams.
- **Filter the feed** by source (clubs, design teams, custom), by term (`F26`, `W27`, no term named), by application type (exec and team roles vs. general membership), by verified-open status, and by search text.
- **See whether a form is really open.** Each card is marked Open (form checked and accepting responses), Unverified, or Closed.
- **Track your applications** on a Bento-grid board: bookmark from the feed or add your own, drag cards between Saved, Applied, Interview, Offer and Not this term, keep notes, and see upcoming deadlines.
- **Add a club that isn't listed** by pasting its Linktree or website; it is scanned immediately.
- **Rescan on demand** with one button, or from the terminal.

## Scope

**In scope**

- Clubs listed in the WUSA Clubs Directory and teams in the Sedra Student Design Centre directory, plus clubs you add by hand.
- Application links reachable from a club's public pages: Instagram bio links, Linktree / Beacons / Carrd pages, public Notion pages, club websites, and forms on Google Forms, Typeform, Tally, Jotform, Airtable and Microsoft Forms.
- Waterloo's term calendar: Winter (Jan–Apr), Spring (May–Aug) and Fall (Sep–Dec), written as `W27`, `S27`, `F26` or in full.

**Out of scope**

- **Accounts and privacy between users.** Everyone who opens a deployment shares one tracker, and anyone can start a scan. Do not host it publicly if that matters to you.
- **Applying on your behalf.** The app links out to each form; it never fills in or submits anything.
- **Anything behind a login.** Instagram itself is never logged in to, and forms restricted to a Google or Microsoft sign-in are listed as Unverified rather than checked.
- **Co-op jobs, WaterlooWorks, and off-campus employers.** This covers student clubs and design teams only.
- **Notifications and scheduled scans.** Scans run when you press the button or run the script.
- **Guaranteed completeness or accuracy.** Clubs that post applications only as Instagram posts or stories, or in Discord, are missed, and the keyword classifier makes mistakes (see [Known limits](#known-limits)).

## Tech stack

| Layer | Technology | Used for |
| --- | --- | --- |
| Framework | **Next.js 16** (App Router, Turbopack) | Pages and API route handlers in one app |
| UI | **React 19**, **TypeScript 5** | Client components for the feed and tracker |
| Styling | **Tailwind CSS 4**, Geist font | Light and dark themes from CSS variables |
| Icons | **Lucide React** | Interface icons |
| ORM | **Prisma 6** | Schema, queries, table creation |
| Database (local) | **SQLite** | Zero-config file at `prisma/dev.db` |
| Database (hosted) | **PostgreSQL** (e.g. Neon on Vercel) | Chosen automatically when `DATABASE_URL` is a Postgres URL |
| HTML scraping | **cheerio**, Node `fetch` | Sedra pages, Linktree JSON, club websites, form pages |
| Directory data | WUSA Clubs public JSON endpoints | Club names, categories, socials |
| Instagram bios | **Apify** `apify/instagram-profile-scraper` (REST), **Serper** search fallback | Bio text and bio links without an Instagram login |
| Notion | Notion's public page endpoints | Finding `<club>.notion.site` and reading public pages |
| Classification | **Google Gemini** (`@google/genai`) or **OpenAI** (`openai`), with a regex / keyword fallback | Deciding which links are active applications |
| Tooling | **ESLint 9**, **tsx**, **GitHub CLI** | Linting, the terminal scraper, repository publishing |
| Runtime | **Node.js 22+** | Uses `--env-file-if-exists` |
| Hosting | Local, or **Vercel** | See [Deploying to Vercel](#deploying-to-vercel) |

All external services are optional. With no keys set, the app runs on the directory data, club websites and the keyword classifier.

## Quick start

```bash
npm install
npm run dev
```

Open http://localhost:3000 and press **Scan clubs now**. Keep the tab open while it scans. `npm run dev` creates the SQLite database on first run, so there is nothing to configure.

A full scan covers about 250 clubs and teams and takes roughly 10 minutes. You can also run it from the terminal:

```bash
npm run scrape                     # discover and scrape everything
npm run scrape -- --limit 10       # quick run: 10 clubs per source
npm run scrape -- --skip-discovery # re-scrape clubs already in the database
```

## Configuration

Copy `.env.example` to `.env`. Every value is optional.

| Variable | Effect |
| --- | --- |
| `APIFY_API_TOKEN` | Read Instagram bio links through Apify, one batch run per scan (uses your Apify credits) |
| `SERPER_API_KEY` | Fallback for bio links when no Apify token is set: one serper.dev search per Instagram handle |
| `GEMINI_API_KEY` | Classify links with Gemini (`GEMINI_MODEL` overrides the model) |
| `OPENAI_API_KEY` | Classify links with OpenAI when no Gemini key is set (`OPENAI_MODEL` overrides the model) |
| `DATABASE_URL` | A Postgres URL switches the app from SQLite to Postgres |

`.env` is gitignored. Never commit keys.

## Deploying to Vercel

The local SQLite file cannot work on Vercel, whose filesystem is read-only and not shared between requests, so a hosted deploy uses Postgres. No code changes are needed:

1. In your Vercel project open **Storage → Create Database → Neon (Postgres)** and connect it to the project. This sets `DATABASE_URL`.
2. Under **Settings → Environment Variables** add any keys you use (`APIFY_API_TOKEN`, `SERPER_API_KEY`, `GEMINI_API_KEY` or `OPENAI_API_KEY`).
3. **Redeploy.** The build runs `scripts/prepare-db.mjs`, which sees the Postgres URL, creates the tables and generates the Prisma client for Postgres.
4. Open the site and press **Scan clubs now**. Keep the tab open: the page drives the scan in short steps, because a serverless function cannot keep working after it responds. Closing the tab pauses the scan; reopening resumes it.

Remember the [scope](#scope): a public deploy has one shared tracker, and anyone who finds it can start a scan that spends your Apify or LLM credits.

## How the pipeline works

`POST /api/scrape` with an empty body starts a run. The page then calls `POST /api/scrape` with `{ "runId" }` repeatedly; each call does one step (discovery, then Instagram bios, then six clubs at a time) until the run is done. `npm run scrape` runs the same pipeline start to finish from the terminal.

1. **Discover clubs** — `lib/discovery.ts`
   - **WUSA clubs** (`clubs.wusa.ca`): the directory is a JavaScript app, so club pages are read through the public JSON endpoints the page itself calls, for name, categories, Instagram handle and website or Linktree links.
   - **Design teams**: the Sedra directory page and each team page are parsed for the team's site and socials.
2. **Read Instagram bios** — `lib/instagram.ts`, with no Instagram login
   - `APIFY_API_TOKEN` set: one run of the `apify/instagram-profile-scraper` actor over every handle, reading `biography`, `externalUrl` and `externalUrls`.
   - Otherwise `SERPER_API_KEY` set: one search per handle (`site:instagram.com/{handle}`), pulling links such as `linktr.ee/club` or `forms.gle/…` out of the result snippet.
   - Neither set: skipped; the website or Linktree from WUSA or Sedra is used.
   - Bios are refreshed at most every 20 hours per club.
3. **Find other pages**
   - **Link-in-bio resolution**: a known Linktree, Beacons or Carrd link → a link-in-bio or `/join` / `/apply` link in the club site's header, nav or footer → `linktr.ee/<instagram handle>` when that page verifiably belongs to the club → the club website.
   - **Notion sites** — `lib/notion.ts` guesses `<clubname>.notion.site` from the club's Instagram handle, website name, acronym and name, and keeps a match only when the workspace name resembles the club. Repeated at most weekly per club.
4. **Scrape each destination** — `scrapeDestination` in `lib/scraper.ts` handles the four common cases. Short links (`tinyurl.com`, `bit.ly`) are followed first.
   - **Direct form**: the form itself is the application; its title is read and it is checked for a closed notice.
   - **Link-in-bio page**: Linktree's `__NEXT_DATA__` JSON and standard `<a>` buttons.
   - **Public Notion page**: read through Notion's page endpoints — its links, plus up to four sub-pages whose titles look like hiring.
   - **Club website**: homepage links plus `/apply`, `/join`, `/recruitment` and `/hiring` pages.
5. **Classify** — `lib/classifier.ts` gets the links and today's date. It understands `F26`, `Fall 2026`, `W27`, "Exec Apps", "Subteam Recruiting" and "Director Applications", and drops Discord, merch, sponsorship packages, events and expired terms. Whatever an LLM says, a link whose named term has ended is dropped by a deterministic check in `lib/terms.ts`.
6. **Verify** — each hiring link is fetched. Google Forms, Typeform, Tally and Jotform are checked for a "no longer accepting responses" notice.

**Status** of each opportunity:

| Status | Meaning |
| --- | --- |
| `OPEN` | The form was fetched and is accepting responses |
| `UNVERIFIED` | Listed on the club's page, but its state can't be confirmed (sign-in-only Google Forms, Microsoft Forms, Airtable, plain web pages) |
| `CLOSED` | The form says it is closed, the link is dead, or it disappeared from the club's page |

**Application type** of each opportunity:

| Type | Meaning | Feed filter |
| --- | --- | --- |
| `EXEC`, `DIRECTOR`, `SUBTEAM`, `VOLUNTEER` | A named selective role | Exec & team roles |
| `GENERAL` | An application that names no specific role | Exec & team roles |
| `MEMBER` | An open membership sign-up or interest form | General membership |

## Project structure

```text
app/
  page.tsx, layout.tsx, globals.css   Page shell and theme
  api/scrape/                         Start a scan, run its next step, report progress
  api/opportunities/                  Hiring feed
  api/clubs/                          List clubs, add a custom club
  api/tracker/                        Tracked applications
components/
  Dashboard.tsx                       Data loading, scan driver, header and stats
  HiringFeed.tsx                      Feed cards and filters
  BentoTracker.tsx                    Bento-grid tracker with drag and drop
lib/
  discovery.ts                        WUSA and Sedra discovery, link-in-bio resolution
  instagram.ts                        Apify and Serper bio link extraction
  notion.ts                           Notion site lookup and page reading
  scraper.ts                          Destination scraping and form verification
  classifier.ts                       LLM and keyword classification
  terms.ts                            Waterloo term and deadline parsing
  pipeline.ts                         Orchestration: full run and resumable steps
  db.ts, http.ts, format.ts, types.ts Shared helpers
prisma/schema.prisma                  Data model
scripts/
  prepare-db.mjs                      Picks SQLite or Postgres and prepares Prisma
  scrape.ts                           Terminal scraper
  publish-github.sh                   Create a GitHub repository and push
```

## API

| Route | Methods | Purpose |
| --- | --- | --- |
| `/api/scrape` | `GET`, `POST` | Run status and stats; `POST {}` starts a run, `POST { "runId" }` does its next step |
| `/api/opportunities` | `GET` | Hiring feed (`?includeClosed=1`) |
| `/api/clubs` | `GET`, `POST` | List clubs; add a custom club `{ "name", "url" }` and scan it |
| `/api/tracker` | `GET`, `POST` | Tracked applications; add from the feed `{ "opportunityId" }` or manually |
| `/api/tracker/[id]` | `PATCH`, `DELETE` | Change stage, notes or deadline; remove |

## Data model

Defined in `prisma/schema.prisma`. Browse the data with `npm run db:studio`.

| Model | Holds |
| --- | --- |
| `Club` | Name, source (`WUSA`, `DESIGN_TEAM`, `CUSTOM`), category, Instagram handle and bio links, website, link-in-bio URL, Notion URL |
| `ApplicationOpportunity` | Title, target term, URL, application type, status, form provider, deadline, confidence, which classifier decided |
| `TrackedApplication` | Your tracker cards: club, role, stage, notes, deadline |
| `ScrapeRun` | Progress and result of each scan |

## Known limits

- **Instagram coverage.** Bios are only read when `APIFY_API_TOKEN` or `SERPER_API_KEY` is set. The Serper route sees only what Google shows in its snippet, so it misses links Instagram keeps out of the bio text. Applications announced only in posts or stories are never seen.
- **Keyword classifier mistakes.** Without an LLM key, classification is by wording. Some event sign-ups are let through as membership sign-ups, and vague links ("Join", "Application form") are filed under team roles.
- **Notion.** Notion only reveals a workspace's public home page. Many clubs have a workspace at `<clubname>.notion.site` with no public home page; those are recorded but nothing can be read from them. Individually shared Notion pages are only found when the club links to them.
- **Notion rate limits.** Requests are sent about one per second, and a rate-limit response pauses Notion lookups for 20 minutes while the scan carries on without them.
- **Unverifiable forms.** Sign-in-only Google Forms, Microsoft Forms and Airtable forms can't be checked for open or closed.
- **Client-rendered pages.** Beacons pages that render entirely in the browser yield few links.
- **Scans need an open tab** in the web app, since the page drives each step.

## Scripts

| Command | Does |
| --- | --- |
| `npm run dev` | Prepare the database and start the dev server |
| `npm run build` / `npm start` | Production build and server |
| `npm run scrape` | Run the full pipeline from the terminal |
| `npm run db:push` | Create or update the database tables |
| `npm run db:studio` | Browse the database |
| `npm run lint` | ESLint |
| `npm run publish:github` | Commit, create a GitHub repository with `gh repo create`, and push (`-- my-repo --public` to name it or make it public) |
