# How oahelper.in works (verified by probing, 2026-09-22)

Stack: **Next.js App Router (turbopack) on Supabase** (`spjkugnxvomrsaapfbgx.supabase.co`,
anon key embedded in client JS). `robots.txt` allows `/`, disallows `/api/` and
`/user_question_images/`, and publishes a sitemap.

## Data arrives as RSC flight payloads, not DOM

There is no `__NEXT_DATA__`. Page data is embedded in
`self.__next_f.push([1,"<escaped>"])` chunks. Unescaped, that is a stream of rows:

```
<hexid>:<payload>
```

**Rows are not delimited.** A marker butts straight against the previous row's
last byte:

```
...Behavioral questions"}1e:T752,<h3>Role: Mechanical Engineer</h3>...
```

`T752` is a **hex byte-length** prefix (1,874 bytes). Honouring it is what keeps
long fields intact — splitting on newlines or on `/<hex>:/` truncates silently.

Fields may hold `"$<hexid>"` **pointers** to another row. Two of the richest text
fields are always pointers:

| Field | Page | Arrives as |
|---|---|---|
| `editorial` | `/problems/...` | `"$22"` → row `22:T475,...` (1,141 chars, contains the answer key) |
| `experience` | `/interview-experience/...` | `"$1e"` → row `1e:T752,...` (1,874 chars) |

`src/flight.ts` handles all of this: `extractFlight` → `tokenizeRows` →
`resolveRefs` → `findKey`.

## Type inconsistency to normalise

`lc_tags` is a **real array** on list pages (`initialQuestions`) but a
**JSON-encoded string** on detail pages (`initialQuestion`). `src/normalize.ts:toTags`
accepts both.

## ID encoding

- Problems: base64 of `"<numeric_id>|0"` — the `|0` is constant across all 8,986.
  Two families: legacy `1–5667` (1,106 gaps, 19.5%) and dense `910000077–910004531`
  (0.7% gaps).
- Interview experiences: **plain** base64 of `"<numeric_id>"` — no `|0` suffix.

## What each URL family yields

| URL | Count | Login | Notes |
|---|---|---|---|
| `/company-questions/<slug>` | 455 | no | `initialCompany` + `initialQuestions` = **the entire catalog, unpaginated**. Accenture: 138/138 present anonymously, premium included. |
| `/problems/<b64>/<slug>` | 8,986 | **for premium** | Full row: statement HTML + Markdown, editorial, 13 code fields, test cases, role/college/campus. |
| `/interview-experiences?page=N` | ~220 pages × 12 | no | Index embeds **full records incl. narrative** → ~18× cheaper than detail pages. `?company=` and `?search=` do **not** filter; only `?page=` works. |
| `/interview-experience/<b64>` | 2,633 | no | One full record. Redundant if the index is crawled. |
| `/company-insights` | 1 | partial | Pre-aggregated analytics, but **only 3 companies are server-rendered**; the rest load client-side. `?company=` does not filter. `/company-insights/<slug>` is 404. |
| `/problems` | 100 pages × 50 | no | `initialTotalCount` = **4,994** — contradicts the sitemap's 8,986. |
| `/mock-oa/<company>` | 21 | no | Assessments with sections, duration, marks. No Accenture. |
| `/oa-calendar` | 1 | **gates data** | Exposes `hidden_count` + an `authenticated` flag; anonymous view is reduced. |
| `/topics/<t>[/<diff>]` | 266 | no | Only JSON-LD `ItemList`; no `initialQuestions`. Low value. |
| `/company-questions/<slug>/topics/<t>` | 1,153 | no | Facet subsets of pages we already fetch. Skip. |

## What the premium gate actually gates

Measured on 3 Accenture premium questions, logged out:

```
premium=true body_present=false md=0 editorial=0 code=0 tags=3
```

All 126 premium URLs **are** in the sitemap, and their metadata (title, tags,
type, difficulty) is fully public. Only the body is withheld. A free question
returns 42 payload keys; a premium one returns 12.

## Open questions

1. **MCQ options are absent** from every payload observed. The editorial argues
   about options A–D but no `options`/`choices` field exists. Must be resolved by
   logged-in network recon (`scripts/login.ts` prints observed `/rest/v1/` calls).
2. **4,994 vs 8,986** problem count. Treat the union of (sitemap ∪ company
   catalogs) as the inventory; record all counts as provenance.
3. `hidden_test_cases_ref` points at blob storage, not inline cases.
