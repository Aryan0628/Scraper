-- ============================================================================
-- Premium flags: one source of truth.
--
-- is_premium holds the API's premium_required (the Pro subscription gate). The
-- company page's lock icon is a different, merged flag -- it appears to be
-- premium_required OR is_mock_oa (verified on Cisco: 34/34) -- so it is only a
-- placeholder until the body fetch runs (see upsertCatalog).
--
-- is_locked answers "is this locked for a free user, for any reason?" and is
-- what to sort/filter on for premium-vs-free.
-- ============================================================================

ALTER TABLE core.questions
  ADD COLUMN IF NOT EXISTS is_locked boolean GENERATED ALWAYS AS (is_premium OR is_mock_oa) STORED;
CREATE INDEX IF NOT EXISTS questions_locked ON core.questions (is_locked);

-- Repair rows where a daily re-catalog overwrote the API flag with the company
-- page's. source_payload is the verbatim API response, so no re-fetch needed.
-- Idempotent: touches only rows that disagree.
UPDATE core.questions
SET is_premium = (source_payload->>'premium_required') IN ('1', 'true'),
    updated_at = now()
WHERE body_fetched_at IS NOT NULL
  AND source_payload ? 'premium_required'
  AND is_premium IS DISTINCT FROM ((source_payload->>'premium_required') IN ('1', 'true'));
