# oascraper

Research scraper for **oahelper.in**, run with written permission from Next Wave.
Builds a dataset of Online Assessment questions per company to study the variety
of questions asked (topic mix, difficulty spread, cross-company reuse).

Keep the permission record in `docs/permission.md`. Aggregates are shareable;
scraped premium statements and solutions are internal only.

## Setup

Requires Node 22+ (TypeScript runs natively, no build step). Tested on Node 26.

```bash
npm install
cp .env.example .env && $EDITOR .env      # Neon connection string
export DATABASE_URL="postgresql://...neon.tech/oascraper?sslmode=require"
node scripts/migrate.ts
```

## Usage

```bash
# Verify the flight parser against committed snapshots (no network)
node scripts/check-flight.ts

# One-company vertical slice: catalog + free bodies + experiences
node scripts/slice.ts --company=accenture

# Same, including premium bodies (needs a session -- see below)
node scripts/login.ts                      # you sign in; nothing is stored but the session
node scripts/slice.ts --company=accenture --premium

# All interview experiences (~220 requests, no login needed)
node scripts/crawl-experiences.ts

# Load a slice into Postgres (idempotent upserts)
node scripts/load.ts --company=accenture
```

## Layout

```
src/flight.ts        RSC flight parser: tokenizer, $ref resolver. The core module.
src/normalize.ts     Coercions for the site's inconsistent field shapes.
src/fetcher.ts       Serial, rate-limited fetch; gzips every page to data/raw/ first.
src/discover.ts      Sitemap -> company / problem / experience URL index.
src/parse/           company.ts, problem.ts, experience.ts
src/db/001_init.sql  Postgres schema.
fixtures/            Committed page snapshots for offline parser tests.
docs/site-notes.md   How the site works, and the traps. Read this first.
```

## Ground rules baked in

- **Concurrency 1**, ~0.7s between requests. This runs against one account; a ban
  ends the project. Do not parallelise.
- **Snapshot before parse.** Every page is gzipped to `data/raw/` with a row in
  `data/raw_pages.ndjson`. Re-parsing never re-requests.
- **Count reconciliation.** `parseCompanyPage` throws if the parsed question count
  disagrees with the company's own `question_count` — this is what catches a
  truncated parse.
- **Premium assertion.** `body_present=false` on a premium row means the session
  expired. Never treat that as "no content".
- Images are not downloaded; `has_image` is recorded instead.
