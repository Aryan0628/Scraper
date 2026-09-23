# Schema design — OA Helper dataset

## What actually exists

Two Postgres schemas, 14 tables and 1 materialised view — everything here holds
scraped data today:

| Schema | Purpose | Tables |
|---|---|---|
| `ingest` | Crawler provenance: snapshots, conflicting source counts | 2 |
| `core` | Content: companies, questions, topics, experiences | 12 + `company_stats` |

Keeping `ingest` separate means the application never joins against scraper
bookkeeping.

## What was designed and then deleted

An earlier draft carried 30 further tables: an `app` schema (users, sessions,
plans, subscriptions, payments, oacoins, contests, referrals, moderation) plus
`core` tables for mock OA, `oa_calendar`, `company_insights`,
`question_metrics` and `experience_questions`.

They were removed because **not one of them had data behind it.** The `app`
tables were inferred from API behaviour rather than scraped, and the remaining
`core` ones describe pages we never parsed. Dead SQL that nothing executes drifts
silently from the live schema and becomes a trap for whoever revives it.

The sections below still describe those features, because the *observations*
remain accurate — what each OA Helper page exposes, and how it would map. Treat
them as design notes to build from when the corresponding crawl lands, not as a
description of tables that exist. Sections covering live tables are marked
**[live]**.

---

## Feature → table mapping

### 1. Company question list **[live]** (`/company-questions/<slug>`)
`core.companies` → `core.company_questions` → `core.questions` → `core.question_topics` → `core.topics`

The counts on the page header (`question_count`, `free/premium`) are **derived**,
not stored: `COUNT(*)` and `COUNT(*) FILTER (WHERE is_premium)` over the join.
The source stores them denormalised and they have already drifted — Amazon's page
declares 46 premium while only 42 rows carry the flag. Storing a count you can
compute is how that happens.

Filter chips (roles, colleges, campus types) come from
`core.roles` / `core.colleges` via `core.company_questions`, not from `text[]`
columns on the company. That is what makes "which roles get DP questions"
answerable.

### 2. Question page **[live]** (`/problems/<id>/<slug>`)
| Panel | Table |
|---|---|
| Title, difficulty, type, premium badge | `core.questions` |
| Statement, editorial, test cases | `core.question_bodies` |
| Language tabs, starter code | `core.question_code` |
| MCQ stem + choices + correct answer | `core.question_mcq_items` + `core.question_options` |
| Topic chips | `core.question_topics` → `core.topics` |
| "Asked at" companies | `core.company_questions` |
| Solved tick / saved flag / private note | *not built* (`app.user_questions`) |
| Run & submit | *not built* (`app.submissions`) |
| **Paywall decision** | *not built* (`app.subscriptions` ∪ `app.company_passes`, then `app.question_views`) |

Everything above the divider is live. The three below need the `app` schema, which
does not exist: they describe a logged-in product, not a dataset.

Their paywall is two questions, not one: *may* this user view (subscription or a
company pass), and *has* this user exhausted their window (view count). Both must
pass — which is why a valid premium session still returned a 429.

### 3. The premium gate and the 150/hour limit **[not built]**

> app schema deleted — kept as an observation of how their limit works.
`app.question_views` is append-only. The check is:

```sql
SELECT count(*) FROM app.question_views
WHERE user_id = $1 AND viewed_at > now() - interval '1 hour';
```

against `app.plans.daily_view_limit`. Append-only rather than a counter column
because a counter loses history, can't answer "what did this account read", and
races under concurrent requests. This is exactly the table that produced our 429.

`app.solution_requests` is a **separate** 15/day quota and must not be conflated
with views — we conflated them at first and wrongly concluded editorials were
capped.

### 4. Interview experiences **[live]**
`core.interview_experiences` → `core.companies` (via `core.company_aliases`)

`company_aliases` is load-bearing: 701 distinct free-text company names map to
455 canonical companies, and 29% of experiences carry no company key at all. Both
`company_id` and `company_name_raw` are kept, so an unresolved alias degrades to
"we know it says Flipkart-Grid" rather than losing the row.

The moderation trail the source exposes (`status`, `reviewed_at`,
`automated_review_id`, `proof_blob_path`, `oacoins_awarded`, `helpful_count`) is
stored as **columns on the experience row**, not as the separate `app.*` tables an
earlier draft proposed. For a read-only dataset that is enough: those tables only
earn their place when users can actually vote, comment and be awarded coins.

### 5. Company insights (`/company-insights`) **[not built]**

> Tables deleted — insights were never parsed, since only 3 companies are
> server-rendered and `?company=` does not filter.

`core.company_insights` + `core.question_metrics`

Deliberately precomputed, not live views — the source ships `generated_at` and
`generation_version`, i.e. a batch job. `question_metrics.times_seen` /
`last_asked` are fed by `app.engagement_responses` ("Have you seen this question
in an actual OA?"), which is the crowd signal behind the numbers.

### 6. Mock OA (`/mock-oa/<company>`) **[not built]**

> Tables deleted — the 21 `/mock-oa/` pages were never parsed.

`core.assessments` → `core.assessment_sections` → `core.assessment_questions` → `core.questions`

`sections` was jsonb in the source. Promoted to tables so a section's questions
can be ordered, scored and reused; jsonb makes "which questions appear in mock
OAs" require unnesting.

### 7. Contests, leaderboard, gamification **[not built]**

> app schema deleted — never scrapeable.
`app.contests` → `app.contest_participants` → `app.submissions`
`app.oacoin_ledger` → `app.leaderboard` (materialised)
`app.daily_rewards`, `app.question_of_the_day`, `app.referrals`

### 8. OA calendar **[not built]**

> table deleted — page gates its rows behind auth.
`core.oa_calendar`. The anonymous view returns `hidden_count` instead of rows —
that is a presentation concern (count vs list), not a second table.

---

## Changes from the research schema, and why

### Tables merged
| Before | After | Reason |
|---|---|---|
| `tags` + `topics` | `core.topics` with `alias_of` self-FK | An alias *is* a topic pointing at another. Two tables required a join for every lookup and made "canonicalise this tag" a cross-table update. |
| solved ids + saved ids + notes | *not built* — would be `app.user_questions` | Three API sources share one key `(user_id, question_id)` and are always read together. Design note only; needs users. |
| `question_options` standalone | keyed to `question_mcq_items` | A composite FK on `(question_id, mcq_index)` makes an orphan option impossible. |

### Tables split
| Before | After | Reason |
|---|---|---|
| `assessments.sections jsonb` | *not built* — would be `assessment_sections` + `assessment_questions` | Ordering, scoring and reverse lookup. Needs the `/mock-oa` crawl first. |
| 13 nullable code columns | `core.question_code` rows | Measured fill: pregiven ×4 at 34 each, solution cpp/python 31, java 27 — a column-per-language layout is ~60% NULL and needs DDL for a new language. |
| `oacoins` balance | *not built* — would be `app.oacoin_ledger` | Balance is `SUM(delta)`; a mutable integer loses history and races. Needs users. |

### The one structural divergence from the source
Their `questions` row carries exactly **one** `company_ref`, so a question asked
at six companies exists as six rows with six ids — measured: **264 questions
duplicated into 353 extra rows (3.9%)**.

Cloning that verbatim would:
- make cross-company reuse unanswerable (no join to traverse),
- store identical 5KB statements up to six times,
- fragment solved/saved state across duplicate ids.

Here a question is stored **once**, linked to many companies through
`core.company_questions`, with `canonical_id` preserving the merge for audit.
This is the single most important deviation and the one worth defending.

---

## Still unresolved

1. **MCQ `mcq_index`** — every row observed uses 1. The key supports multi-part
   questions; if they never exist, it can be dropped later (cheap now, expensive
   to add retrospectively).
2. **`hidden_test_cases_ref`** — 4/35 populated, points at blob storage we do not
   fetch. Modelled as a pointer, not content.
3. **Images** — excluded by choice; `has_image` is kept so nothing is silently
   lost. Endpoint is `/api/proxy/question_images` if that changes.
4. **`app.users.email`** needs `CREATE EXTENSION citext`, or change to
   `text` + a `lower(email)` unique index.
