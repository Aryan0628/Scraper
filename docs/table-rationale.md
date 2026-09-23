# Table-by-table rationale

Every claim below is measured against the 185 questions, 2,633 interview
experiences and 2 company catalogs currently on disk.

---

## `core.companies`

**Holds:** the 455 canonical companies.

**Their problem — denormalised counts that have already drifted.** The company
payload ships `question_count`, `free_question_count`, `premium_question_count`.
Amazon's page declares **46 premium**; only **42** of its 47 rows actually carry
`premium_required=1`. Their own numbers disagree by 4.

**What we changed:** we do not store those counts. They are
`COUNT(*) FILTER (WHERE is_premium)` over `core.company_questions`. A count you
can compute is a count that can lie. The originals go to
`ingest.source_counts` as observations, not truth — useful for reconciling a
crawl, never read by the application.

## `core.company_aliases`

**Holds:** 701 lowercased raw company strings → 455 canonical companies.

**Their problem — company as free text on experiences.** Interview experiences
carry `company` as whatever the submitter typed. Measured: **701 distinct raw
names**, and only **71% (1,874/2,633)** have a `practice_company_key`. So ~760
experiences reference a company that no foreign key points at. "flipkart",
"flipkart-grid", "flipkart-grid-8-0" are three different strings for one employer.

**Why we kept it:** without this table those 760 experiences are permanently
unattributable, and that is 29% of the largest complete dataset we have. It is
pure scaffolding — the clone would write `company_id` at submission time — but
for imported data it is load-bearing.

## `core.roles` / `core.colleges`

**Their problem — the same fact stored two incompatible ways.** A company row
carries `roles text[]` and `colleges text[]`; a question row carries `role` and
`college_name` as bare strings. Neither references the other, so "which roles get
graph questions" cannot be expressed as a join.

**What we changed:** lookup tables, referenced from `core.company_questions`.
Small tables (15 roles, 9 colleges today) but they turn a string-matching problem
into a join.

## `core.questions`

**Their problem #1 — one company per question, so questions are duplicated.**
Each row carries exactly one `company_ref`. A question asked at six companies is
six rows with six ids. Measured across the sitemap: **264 questions duplicated
into 353 extra rows (3.9%)** — `card-range-obfuscation` ×6,
`ride-share-surge-pricing-replay` ×6.

Consequences: cross-company reuse is unanswerable (no join exists), a 5 KB
statement is stored up to six times, and a user's solved/saved state fragments
across ids that are the same question.

**What we changed — the most important divergence.** A question is stored once;
companies attach through `core.company_questions`. `canonical_id` records a merge
so the decision is auditable and reversible.

**Their problem #2 — `difficulty` and `difficulty_score` are both stored and
neither derives the other.** Measured bands overlap: easy 15..42, medium 38..66,
hard 62..70. A score of 40 is genuinely ambiguous.

**What we changed:** both columns kept, `CHECK (difficulty_score BETWEEN 0 AND 100)`,
and we never infer the label from the score. (An earlier version of our own
normaliser bucketed `<40/<70/else` and silently mislabelled every list-only row —
that is now removed.)

**Their problem #3 — meaningless id encoding.** Ids are base64 of `"<id>|0"`
where `|0` is constant across all 8,986. Two families exist: legacy `1..5667`
with 19.5% gaps, and a dense `910000077..910004531` block — the fingerprint of a
migration or a merged second corpus.

**What we changed:** `bigserial` primary key, with `source_id` / `source_numeric_id`
retained for provenance. Never join on someone else's encoded string.

## `core.question_bodies`

**Why split from `questions`:** statements and editorials are large and cold. The
biggest observed is a 5,544-char statement with a 4,988-char editorial, while the
company list view needs only title, type and difficulty. Splitting keeps the hot
catalog table narrow, and the generated `search_tsv` lives next to the text it
indexes.

**Their quirk:** `search_vector` — a Postgres `tsvector` — is serialised into the
API response to the browser. An internal index artifact leaking into the wire
format. Ours stays server-side as a `GENERATED ... STORED` column.

## `core.question_code`

**Their problem — a repeating group as 13 columns.** `solution_cpp`,
`solution_python`, `solution_java`, `sql_solution`, `bash_solution`,
`js_solution`, `prompt_solution`, `solution`, `solution_code`, `pregiven_code`,
`pregiven_code_cpp`, `pregiven_code_python`, `pregiven_code_java`.

Measured on 36 coding questions: 468 column-slots, **232 filled — 50% NULL**.
Adding Go or Rust means an `ALTER TABLE` and a deploy.

**What we changed:** rows keyed `(question_id, kind, lang)`. A new language is a
new row. Note the source also has both `solution` and `solution_code` with no
discernible distinction — we keep them as `lang='generic'` and
`lang='generic_code'` rather than guessing they are the same thing.

## `core.question_mcq_items` + `core.question_options`

**Their problem — another repeating group, `option_1..option_4`.** Measured:
143 MCQs with 4 options, **1 with 3** (a wasted column), **1 with 0** (an MCQ
with no choices at all — a data bug on their side). The layout cannot represent
a 5-option question without schema change.

Also note `correct_option_letters` is an array of letters like `["A"]`, which
only means anything if you know the letter maps to `option_1`.

**What we changed:** one row per option, `is_correct` on the row itself. The
correct answer is `WHERE is_correct`, not an array you must decode against
column positions. Options hang off `question_mcq_items` by composite FK so an
orphan option is impossible, and `mcq_index` allows multi-part questions —
every observed row uses 1, but the key costs nothing now and is expensive to
retrofit.

## `core.topics` + `core.question_topics`

**Their problem — `lc_tags` changes type by endpoint.** A real JSON array on list
endpoints, a JSON-*encoded string* on detail endpoints. The same field, two
types, depending which route you hit.

**What we changed:** normalised rows, plus `alias_of` as a self-reference so
"spark" and "Spark" and "apache-spark" collapse to one canonical topic without a
second table. `question_topics.source` records whether a tag came from the site,
an LLM, or a human — so machine guesses never silently become ground truth.

## `core.company_questions`

The join that makes the headline research question expressible. Carries the
facts that are properties of *the asking*, not of the question: role, college,
campus type, date asked, sort order.

**Implementation note:** the uniqueness rule is a unique **index** with
`coalesce(role_id,0)`, not a primary key — Postgres forbids expressions in a
primary key, and without the coalesce two NULL-role rows would both be allowed
since `NULL <> NULL`.

## `core.interview_experiences`

**Their problem — silent truncation.** Measured:

| Field | Max length | Rows at exactly that cap |
|---|---|---|
| `difficulty` | 50 | **224** |
| `result` | 50 | **177** |
| `rounds` | 100 | 53 |

Truncated mid-word: `"Average for online assessment, Technical and HR no"`,
`"Selected (Implied by the detailed progression thro"`. That is `varchar(50)`
cutting real submissions in half — **401 rows with permanently lost content**.

**What we changed:** `text` everywhere. Postgres `text` and `varchar(n)` have
identical performance; the length limit buys nothing and destroys data.

**Also:** `difficulty_raw` is deliberately *not* the enum. Submitters write
"Hard (due to breadth of topics)", which is not one of three values. Forcing it
into an enum would either fail or lie.

## `ingest.raw_pages` / `ingest.source_counts`

`raw_pages` is provenance: every parsed byte traces to a gzipped snapshot, so a
parser fix re-runs locally instead of re-crawling — which matters doubly given
the 150/hour cap.

`source_counts` exists because the source's own numbers conflict: the sitemap
lists 8,986 problems, `/problems` reports `initialTotalCount: 4,994`, and
Amazon's premium count is off by 4. We record each claim with a timestamp rather
than picking a winner.

---

## Summary of divergences

| Their design | Ours | Driven by |
|---|---|---|
| One company per question row | Question once + M:N join | 264 questions, 353 duplicate rows |
| 13 code columns | Rows by `(kind, lang)` | 50% NULL |
| `option_1..option_4` | One row per option | 4/3/0-option cases observed |
| `varchar(50)` on experience fields | `text` | 401 truncated rows |
| Denormalised counts on company | Computed | Amazon off by 4 |
| `roles text[]` + `role text` | Lookup tables + FK | Unjoinable today |
| `lc_tags` array-or-string | Normalised rows | Type varies by endpoint |
| Base64 `"<id>\|0"` as key | `bigserial` + `source_id` | `\|0` is constant noise |
| `tsvector` sent to the browser | Server-side generated column | Index artifact on the wire |
