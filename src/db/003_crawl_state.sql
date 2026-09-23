-- ============================================================================
-- ingest -- crawl orchestration state.
-- Per-company catalog status only. Question-body progress is NOT duplicated
-- here: it lives on core.questions.body_fetched_at (NULL = still owed), so the
-- two can never disagree. This table answers "which catalogs are done/failed",
-- which core.questions alone cannot express.
-- ============================================================================

CREATE TABLE IF NOT EXISTS ingest.company_crawl (
  slug            text PRIMARY KEY,
  catalog_status  text NOT NULL DEFAULT 'pending',  -- pending|done|failed
  catalog_at      timestamptz,                      -- last successful catalog fetch
  question_count  int,
  attempts        int NOT NULL DEFAULT 0,
  last_error      text,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS company_crawl_status ON ingest.company_crawl (catalog_status);

-- One row per orchestrator run, for observability from GCP logs / the DB.
CREATE TABLE IF NOT EXISTS ingest.crawl_runs (
  id              bigserial PRIMARY KEY,
  mode            text NOT NULL,                    -- backfill|daily
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  companies_seen  int NOT NULL DEFAULT 0,
  bodies_fetched  int NOT NULL DEFAULT 0,
  experiences_seen int NOT NULL DEFAULT 0,
  stopped_reason  text                              -- complete|rate_limited|session_dead|error|interrupted
);
ALTER TABLE ingest.crawl_runs ADD COLUMN IF NOT EXISTS experiences_seen int NOT NULL DEFAULT 0;
