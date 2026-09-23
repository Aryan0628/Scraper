# scraper

Research scraper for **oahelper.in**, run with written permission from Next Wave.
Builds a dataset of Online Assessment questions per company to study the variety
of questions asked (topic mix, difficulty spread, cross-company reuse).

Keep the permission record in `docs/permission.md`. Aggregates are shareable;
scraped premium statements and solutions are internal only.

## Setup

Requires Node 22+ (TypeScript runs natively, no build step). Tested on Node 26.

```bash
npm install
cp .env.example .env && $EDITOR .env      # fill in DATABASE_URL (see below)
node --env-file=.env scripts/migrate.ts
```

`.env` holds two values; both are documented in `.env.example`:

- **`DATABASE_URL`** — Neon pooled connection string. Get it from Neon Dashboard
  → your project → Connection Details → *Pooled connection*. Use the
  `ap-southeast-1` (Singapore) region from India for ~100ms latency vs ~525ms
  from Ohio.
- **`OA_SESSION`** — only needed for authenticated body fetches. Locally you can
  leave it unset: `scripts/login.ts` writes `.secrets/storageState.json` and the
  scraper reads that file. `OA_SESSION` is only for GCP (see the deploy
  section), where there is no filesystem to persist the login.

For GCP, do NOT commit `.env` — inject both values via Secret Manager as shown
in the *Deploying to GCP* section below.

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

## Deploying to GCP (Cloud Run Job)

The crawler is designed to run as a **Cloud Run Job** (not a service — it's a
scheduled batch, not a request handler). Two secrets have to be provided; the
image itself is stateless.

### 1. Store the two secrets in Secret Manager

**`DATABASE_URL`** — the Neon connection string.

```bash
gcloud secrets create oascraper-db-url --replication-policy=automatic
printf 'postgresql://USER:PASS@HOST.neon.tech/oascraper?sslmode=require' \
  | gcloud secrets versions add oascraper-db-url --data-file=-
```

**`OA_SESSION`** — the logged-in session, base64 of the storageState JSON that
`scripts/login.ts` writes locally to `.secrets/storageState.json`.

```bash
# On your laptop, after `node scripts/login.ts` has written .secrets/storageState.json:
base64 -i .secrets/storageState.json \
  | gcloud secrets create oascraper-session --data-file=- --replication-policy=automatic

# When it expires (crawler logs "SESSION DEAD"), rotate:
node scripts/login.ts
base64 -i .secrets/storageState.json \
  | gcloud secrets versions add oascraper-session --data-file=-
```

The scraper accepts either raw JSON or base64 in `OA_SESSION` — base64 is
recommended because Secret Manager's UI mangles the newlines in raw JSON.

### 2. Build and push the image

```bash
gcloud builds submit --tag gcr.io/YOUR_PROJECT/oascraper
```

### 3. Create the Cloud Run Job

```bash
gcloud run jobs create oascraper-daily \
  --image gcr.io/YOUR_PROJECT/oascraper \
  --region asia-south1 \
  --task-timeout 3600 \
  --max-retries 1 \
  --set-secrets DATABASE_URL=oascraper-db-url:latest,OA_SESSION=oascraper-session:latest \
  --command node --args scripts/crawl.ts,daily
```

Change the last arg to `backfill` for the first full run, then switch to `daily`
for subsequent scheduled runs. Other modes: `catalog`, `bodies`, `experiences`
(each phase in isolation).

### 4. Schedule it

```bash
gcloud scheduler jobs create http oascraper-nightly \
  --location asia-south1 \
  --schedule "0 3 * * *" \
  --uri "https://asia-south1-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/YOUR_PROJECT/jobs/oascraper-daily:run" \
  --http-method POST \
  --oauth-service-account-email SCHEDULER_SA@YOUR_PROJECT.iam.gserviceaccount.com
```

### What GOOGLE never sees

- `DATABASE_URL` and `OA_SESSION` are only ever injected as **env vars at task
  start**; nothing lands on disk. The Dockerfile intentionally does not `COPY`
  any secrets, and there is no `--env-file` in `CMD`.
- `data/` is not baked into the image. The sitemap is refetched every run, and
  the real "what's done" state is `core.questions.body_fetched_at` in Postgres,
  so a fresh container loses nothing.

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
