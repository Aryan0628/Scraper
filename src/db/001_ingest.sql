-- ============================================================================
-- SCHEMA: ingest -- scraper provenance. Exists only while we are the ones
-- populating the data; a running clone would drop this entirely.
-- Kept separate so the application schema stays clean of crawler concerns.
-- ============================================================================
CREATE SCHEMA IF NOT EXISTS ingest;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS ingest.raw_pages (
  content_hash  text PRIMARY KEY,
  url           text NOT NULL,
  kind          text,                    -- company | problem | q | mcq | experience
  http_status   int,
  fetched_at    timestamptz NOT NULL,
  content_type  text,
  path          text NOT NULL,           -- gzipped snapshot on disk
  byte_size     int,
  authenticated boolean NOT NULL DEFAULT false
);

-- The source's own counts disagree with reality (Amazon declares 46 premium,
-- rows say 42). Keep every count we were told, rather than trusting one.
CREATE TABLE IF NOT EXISTS ingest.source_counts (
  scope        text NOT NULL,            -- 'company' | 'global'
  scope_key    text NOT NULL,            -- slug, or 'sitemap' / 'problems_index'
  metric       text NOT NULL,            -- question_count | premium_count | total
  value        int  NOT NULL,
  observed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, scope_key, metric, observed_at)
);
