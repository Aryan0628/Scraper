
CREATE SCHEMA IF NOT EXISTS core;
DO $$ BEGIN CREATE TYPE core.question_kind  AS ENUM ('coding','mcq','sql','subjective','other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE core.difficulty     AS ENUM ('easy','medium','hard');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE core.campus_kind    AS ENUM ('on_campus','off_campus');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------- companies
CREATE TABLE IF NOT EXISTS core.companies (
  id                  bigserial PRIMARY KEY,
  slug                text UNIQUE NOT NULL,
  name                text NOT NULL,
  logo_url            text,
  source_id           text UNIQUE,              -- their base64 id, NULL for our own
  solutions_available boolean NOT NULL DEFAULT false,
  premium_only        boolean,
  has_free_questions  boolean,
  recent_questions    jsonb,                    -- titles the source highlights
  source_date         date,                     -- their `date` field
  -- Keep the SOURCE's timestamps distinct from ours. Overwriting them with now()
  -- destroys change detection: an incremental re-crawl needs to know when THEY
  -- last changed a row, not when we last wrote it.
  source_created_at   timestamptz,
  source_updated_at   timestamptz,
  source_payload      jsonb,                    -- verbatim payload; see note below
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz
);

-- 701 distinct free-text company names appear across interview experiences
-- against 455 canonical companies ("flipkart", "Flipkart ", "flipkart-grid-8-0").
-- Without this table 29% of experiences can never be attributed to a company.
CREATE TABLE IF NOT EXISTS core.company_aliases (
  alias      text PRIMARY KEY,                  -- lowercased raw string
  company_id bigint REFERENCES core.companies ON DELETE CASCADE,
  confidence real NOT NULL DEFAULT 1.0,
  method     text                               -- exact | trgm | manual
);
CREATE INDEX IF NOT EXISTS company_aliases_trgm ON core.company_aliases USING gin (alias gin_trgm_ops);

-- Normalised lookups. The source keeps these as text[] on the company and bare
-- text on the question, which makes "which roles get which questions" unqueryable.
CREATE TABLE IF NOT EXISTS core.roles    (id bigserial PRIMARY KEY, name text UNIQUE NOT NULL);
CREATE TABLE IF NOT EXISTS core.colleges (id bigserial PRIMARY KEY, name text UNIQUE NOT NULL);

-- ---------------------------------------------------------------- questions
-- IMPORTANT DIVERGENCE FROM THE SOURCE.
-- Their questions table carries exactly one company_ref, so a question asked at
-- six companies exists as six rows with six ids (measured: 264 such questions,
-- 353 duplicate rows). Cloning that verbatim makes cross-company reuse
-- unanswerable and triples storage of identical statements.
-- Here a question is stored ONCE and linked to many companies via
-- core.company_questions. canonical_id preserves the merge for auditability.
CREATE TABLE IF NOT EXISTS core.questions (
  id                 bigserial PRIMARY KEY,
  slug               text NOT NULL,
  title              text NOT NULL,
  title_norm         text NOT NULL,
  kind               core.question_kind,
  difficulty         core.difficulty,
  difficulty_score   int CHECK (difficulty_score BETWEEN 0 AND 100),
  is_premium         boolean NOT NULL DEFAULT false,
  has_image          boolean NOT NULL DEFAULT false,
  publication_status text NOT NULL DEFAULT 'published',
  is_mock_oa         boolean NOT NULL DEFAULT false,
  -- The source returns 403 mock_oa_answer_locked for a mock test's answer key
  -- until the attempt is submitted. Recording it distinguishes "this MCQ has no
  -- options" from "options exist but were withheld" -- without it, a locked
  -- question is indistinguishable from a parsing failure.
  answers_locked     boolean NOT NULL DEFAULT false,
  is_first_in_company boolean,
  source_id          text UNIQUE,               -- their base64 "<id>|0"
  source_numeric_id  bigint,
  canonical_id       bigint REFERENCES core.questions,  -- set when merged
  merge_method       text,                      -- exact_title | trgm | manual
  content_hash       text,
  -- Two-phase ingest marker. Catalog pages give title/topics/type for free and
  -- uncapped; statements cost one request each against a 150/hour limit, so the
  -- two arrive days apart. NULL here means "catalogued, body still owed" and is
  -- what drives the worklist for the next authenticated batch.
  body_fetched_at    timestamptz,
  source_created_at  timestamptz,               -- THEIR timestamps, not ours
  source_updated_at  timestamptz,
  -- Verbatim API response. Normalised columns are a projection of this, never a
  -- replacement for it: any field we did not think to model is still here, and a
  -- new column can be backfilled with an UPDATE instead of a re-crawl -- which
  -- matters when re-crawling costs 150 requests/hour.
  -- Cost is small: ~2KB/question TOAST-compressed, ~18MB at full corpus.
  source_payload     jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz
);
CREATE INDEX IF NOT EXISTS questions_kind_diff  ON core.questions (kind, difficulty);
CREATE INDEX IF NOT EXISTS questions_premium    ON core.questions (is_premium);
CREATE INDEX IF NOT EXISTS questions_canonical  ON core.questions (canonical_id);
CREATE INDEX IF NOT EXISTS questions_title_trgm ON core.questions USING gin (title_norm gin_trgm_ops);
-- The worklist: partial index, so it stays tiny as the backlog drains.
--   SELECT source_id FROM core.questions
--   WHERE body_fetched_at IS NULL AND deleted_at IS NULL
--   ORDER BY is_premium, id LIMIT 145;   -- one hour's quota
CREATE INDEX IF NOT EXISTS questions_body_pending ON core.questions (id)
  WHERE body_fetched_at IS NULL;

-- Split from questions: statements/editorials are large and cold, the catalog
-- list view reads questions only. Measured ~27KB+ per row on coding questions.
CREATE TABLE IF NOT EXISTS core.question_bodies (
  question_id            bigint PRIMARY KEY REFERENCES core.questions ON DELETE CASCADE,
  google_doc_link        text,
  statement_html         text,
  statement_md           text,
  editorial              text,
  input_test_case        text,
  output_test_case       text,
  hidden_test_cases_ref  text,                  -- blob pointer; 4/35 populated
  hidden_test_cases_count int,
  youtube_tutorial       text,
  visual_animation       text,
  search_tsv tsvector GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(statement_md, ''))
  ) STORED
);
CREATE INDEX IF NOT EXISTS question_bodies_fts ON core.question_bodies USING gin (search_tsv);

-- Replaces 13 flat nullable columns. Observed fill: pregiven x4 (34 each),
-- solution cpp/python 31, java 27 -- a column-per-language design is ~60% NULL.
CREATE TABLE IF NOT EXISTS core.question_code (
  question_id bigint NOT NULL REFERENCES core.questions ON DELETE CASCADE,
  kind        text   NOT NULL,                  -- solution | pregiven
  lang        text   NOT NULL,                  -- cpp|python|java|sql|bash|js|prompt|generic
  code        text   NOT NULL,
  PRIMARY KEY (question_id, kind, lang)
);

CREATE TABLE IF NOT EXISTS core.question_mcq_items (
  question_id          bigint NOT NULL REFERENCES core.questions ON DELETE CASCADE,
  mcq_index            int    NOT NULL DEFAULT 1,
  stem                 text,
  selection_type       text,                    -- single | multiple
  solution_explanation text,
  PRIMARY KEY (question_id, mcq_index)
);
CREATE TABLE IF NOT EXISTS core.question_options (
  question_id bigint  NOT NULL,
  mcq_index   int     NOT NULL DEFAULT 1,
  label       text    NOT NULL,                 -- 'A'..'H'
  body        text    NOT NULL,
  is_correct  boolean NOT NULL DEFAULT false,
  PRIMARY KEY (question_id, mcq_index, label),
  FOREIGN KEY (question_id, mcq_index)
    REFERENCES core.question_mcq_items (question_id, mcq_index) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS question_options_correct ON core.question_options (question_id) WHERE is_correct;

-- Images are referenced, not stored. /api/proxy/question_images returns only
-- {id, uploaded_at}; the bytes come from /api/proxy/serve_image?id=...&v=orig.
-- Recording the id keeps every statement's figures addressable without pulling
-- binaries into the database, and the URL can be rebuilt from the id at any time.
CREATE TABLE IF NOT EXISTS core.question_images (
  question_id bigint NOT NULL REFERENCES core.questions ON DELETE CASCADE,
  image_id    bigint NOT NULL,
  uploaded_at timestamptz,
  ordinal     int,
  PRIMARY KEY (question_id, image_id)
);

-- MERGED: the old tags + topics pair collapses into one self-referencing table.
-- Two tables were never justified -- an alias IS a topic that points at another.
CREATE TABLE IF NOT EXISTS core.topics (
  id       bigserial PRIMARY KEY,
  name     text UNIQUE NOT NULL,
  kind     text,                                -- topic | skill | pattern
  alias_of bigint REFERENCES core.topics,       -- NULL = canonical
  CHECK (alias_of IS NULL OR alias_of <> id)
);
CREATE TABLE IF NOT EXISTS core.question_topics (
  question_id bigint NOT NULL REFERENCES core.questions ON DELETE CASCADE,
  topic_id    bigint NOT NULL REFERENCES core.topics ON DELETE CASCADE,
  confidence  real,
  source      text NOT NULL DEFAULT 'source',   -- source | llm | human
  PRIMARY KEY (question_id, topic_id)
);

-- The join that makes cross-company reuse a first-class query.
CREATE TABLE IF NOT EXISTS core.company_questions (
  company_id  bigint NOT NULL REFERENCES core.companies ON DELETE CASCADE,
  question_id bigint NOT NULL REFERENCES core.questions ON DELETE CASCADE,
  -- Raw strings land immediately; the *_id lookups are filled by a later pass.
  -- Storing both means a load never blocks on normalisation, and the original
  -- spelling survives if our matching is wrong.
  role_raw    text,
  college_raw text,
  role_id     bigint REFERENCES core.roles,
  college_id  bigint REFERENCES core.colleges,
  campus_type core.campus_kind,
  asked_on    date,
  sort_order  int,
  source_url  text,
  id          bigserial PRIMARY KEY
);
-- NOTE: a PRIMARY KEY cannot contain expressions, so the "one row per
-- (company, question, role, college)" rule is enforced by a unique INDEX, where
-- coalesce() IS allowed. Without the coalesce, NULL role/college would let
-- duplicates through, since NULL <> NULL in a unique constraint.
CREATE UNIQUE INDEX IF NOT EXISTS company_questions_uniq
  ON core.company_questions (company_id, question_id,
                             coalesce(role_id, 0), coalesce(college_id, 0));
CREATE INDEX IF NOT EXISTS company_questions_q ON core.company_questions (question_id);

-- ------------------------------------------------------ interview experiences
CREATE TABLE IF NOT EXISTS core.interview_experiences (
  id                bigserial PRIMARY KEY,
  source_numeric_id bigint UNIQUE,
  company_id        bigint REFERENCES core.companies,
  company_name_raw  text NOT NULL,              -- keep raw: 29% never resolve
  author_user_id    bigint,                     -- app.users when self-hosted
  role_id           bigint REFERENCES core.roles,
  college_id        bigint REFERENCES core.colleges,
  -- Their raw dates arrive in two formats, incl. "09-08-2026". For any day <= 12
  -- that is unresolvable (9 Aug or 8 Sep?), so we keep what we were given and
  -- flag how confident the parse was, rather than silently inventing a date.
  interview_date     date,
  interview_date_raw text,
  date_is_ambiguous  boolean NOT NULL DEFAULT false,
  interview_type     text,

  -- result has 496 distinct values for a ~5-value concept ("Selected", "Offer",
  -- "Selected (Implied)" are one outcome). Keep the submission verbatim AND a
  -- normalised column; never overwrite what the user wrote.
  result_raw        text,
  result            text,                       -- selected|rejected|pending|unknown

  difficulty_raw    text,                       -- free text: "Hard (due to breadth...)"

  -- rounds is prose in 2,221 of 2,473 rows ("3 technical rounds (plus...)").
  -- Extract the number where one exists; keep the prose always.
  rounds_raw        text,
  rounds_count      int,

  topics_asked      text,                       -- free text; see experience_topics

  -- 526 groups share a company and an identical opening 200 chars. Same merge
  -- pattern as questions: keep every row, point duplicates at a representative.
  content_hash      text,
  canonical_id      bigint REFERENCES core.interview_experiences,
  body_html         text,
  status            text NOT NULL DEFAULT 'approved',
  helpful_count     int  NOT NULL DEFAULT 0,

  -- The source's own linkage: present on 71% of rows and the ONLY reliable way
  -- to attribute an experience to a company. Dropping it would force every
  -- attribution through fuzzy name matching.
  practice_company_key text,
  practice_company_ref text,

  -- Contribution / moderation trail the source exposes.
  oacoins_awarded     int,
  has_questions       boolean NOT NULL DEFAULT false,
  proof_blob_path     text,
  reviewed_at         timestamptz,
  automated_review_id text,

  source_created_at timestamptz,                -- THEIR timestamps, not ours
  source_updated_at timestamptz,
  source_payload    jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  search_tsv tsvector GENERATED ALWAYS AS (
    to_tsvector('english',
      coalesce(topics_asked,'') || ' ' || coalesce(rounds_raw,'') || ' ' || coalesce(body_html,''))
  ) STORED
);
CREATE INDEX IF NOT EXISTS ie_company ON core.interview_experiences (company_id);
CREATE INDEX IF NOT EXISTS ie_fts     ON core.interview_experiences USING gin (search_tsv);

-- ---------------------------------------------------------- derived counts
-- Denormalising counts is fine; denormalising them WITHOUT a maintenance
-- mechanism is what let the source drift (Amazon declares 46 premium, 42 rows
-- carry the flag). So we precompute, but the database owns the number -- never
-- application code.
--
-- Cost of computing live, for reference: company_questions holds ~9k rows for
-- the whole site, so a GROUP BY is sub-millisecond and the detail page is a
-- ~140-row index scan. The reason to materialise is not the join cost, it is
-- ORDER BY count + LIMIT on the /companies index, which cannot use an index and
-- must aggregate everything before paginating.
CREATE MATERIALIZED VIEW IF NOT EXISTS core.company_stats AS
SELECT
  c.id AS company_id,
  count(cq.question_id)                                            AS question_count,
  count(cq.question_id) FILTER (WHERE q.is_premium)                AS premium_count,
  count(cq.question_id) FILTER (WHERE NOT q.is_premium)            AS free_count,
  count(DISTINCT cq.role_id)                                       AS role_count,
  count(DISTINCT cq.college_id)                                    AS college_count,
  max(cq.asked_on)                                                 AS last_asked_on
FROM core.companies c
LEFT JOIN core.company_questions cq ON cq.company_id = c.id
LEFT JOIN core.questions q ON q.id = cq.question_id AND q.deleted_at IS NULL
WHERE c.deleted_at IS NULL
GROUP BY c.id;

-- UNIQUE index is required for REFRESH ... CONCURRENTLY, which lets the
-- /companies page keep serving while the view rebuilds.
CREATE UNIQUE INDEX IF NOT EXISTS company_stats_pk ON core.company_stats (company_id);
CREATE INDEX IF NOT EXISTS company_stats_by_count  ON core.company_stats (question_count DESC);

-- Refresh after a crawl/load, not per-write: this is a batch-written catalog,
-- so staleness between loads is acceptable and rebuild cost is trivial at 455 rows.
CREATE OR REPLACE FUNCTION core.refresh_stats() RETURNS void
LANGUAGE sql AS $$
  REFRESH MATERIALIZED VIEW CONCURRENTLY core.company_stats;
$$;

-- topics_asked splits into 8,927 distinct free-text fragments across 2,507 rows,
-- so it cannot join to core.topics as-is. This is where the LLM normalisation
-- pass earns its place: map fragments onto the canonical vocabulary once, store
-- the links here, and leave the original string untouched on the experience.
CREATE TABLE IF NOT EXISTS core.experience_topics (
  experience_id bigint NOT NULL REFERENCES core.interview_experiences ON DELETE CASCADE,
  topic_id      bigint NOT NULL REFERENCES core.topics ON DELETE CASCADE,
  confidence    real,
  source        text NOT NULL DEFAULT 'llm',
  PRIMARY KEY (experience_id, topic_id)
);
CREATE INDEX IF NOT EXISTS experience_topics_topic ON core.experience_topics (topic_id);
CREATE INDEX IF NOT EXISTS ie_canonical ON core.interview_experiences (canonical_id);
CREATE INDEX IF NOT EXISTS ie_result    ON core.interview_experiences (result);
