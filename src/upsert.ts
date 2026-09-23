/**
 * Shared DB upserts. Used by the live orchestrator (scripts/crawl.ts) so a body
 * is written and marked fetched in one place, and by the file loader
 * (scripts/load.ts, which keeps its own bulk path for reloading from snapshots).
 *
 * `sql` is a postgres.js tag; typed as any to avoid pulling the driver's types
 * through every call site, consistent with the rest of the scripts.
 */
import { createHash } from 'node:crypto';

type Sql = any;
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const ENUM_KIND = new Set(['coding', 'mcq', 'sql', 'subjective', 'other']);
const ENUM_CAMPUS = new Set(['on_campus', 'off_campus']);

export async function upsertCompany(sql: Sql, company: any): Promise<number> {
  const [c] = await sql`
    INSERT INTO core.companies (
      slug, name, source_id, solutions_available, premium_only, has_free_questions,
      recent_questions, source_date, source_created_at, source_updated_at,
      source_payload, updated_at)
    VALUES (
      ${company.slug}, ${company.name}, ${company.source_id},
      ${company.solutions_available ?? false}, ${company.premium_only ?? null},
      ${company.has_free_questions ?? null},
      ${sql.json(company.recent_questions ?? null)}, ${company.date ?? null},
      ${company.source_created_at ?? null}, ${company.source_updated_at ?? null},
      ${sql.json(company)}, now())
    ON CONFLICT (slug) DO UPDATE SET
      name = EXCLUDED.name,
      solutions_available = EXCLUDED.solutions_available,
      premium_only = EXCLUDED.premium_only,
      recent_questions = EXCLUDED.recent_questions,
      source_updated_at = EXCLUDED.source_updated_at,
      source_payload = EXCLUDED.source_payload,
      updated_at = now()
    RETURNING id`;
  return c.id;
}

/**
 * Upsert a company's catalog: the question rows (body_fetched_at left as-is, so
 * a re-catalog never resets an already-fetched body), the company<->question
 * links, and topic links. Returns the source_id -> question id map.
 */
export async function upsertCatalog(
  sql: Sql,
  companyId: number,
  questions: any[],
  slugById: Map<string, string>,
): Promise<Map<string, number>> {
  const qRows = dedupe(
    questions.map((q) => ({
      slug: slugById.get(q.source_id) ?? q.title_norm.replace(/\s+/g, '-'),
      title: q.title,
      title_norm: q.title_norm,
      kind: ENUM_KIND.has(q.qtype ?? '') ? q.qtype : q.qtype ? 'other' : null,
      difficulty: q.difficulty,
      difficulty_score: q.difficulty_score,
      is_premium: q.premium_required,
      source_id: q.source_id,
      source_numeric_id: q.numeric_id,
      source_updated_at: q.source_updated_at ?? null,
    })),
    (r) => r.source_id,
  );

  const idBySource = new Map<string, number>();
  for (const chunk of chunks(qRows, 500)) {
    const out = await sql`
      INSERT INTO core.questions ${sql(chunk)}
      ON CONFLICT (source_id) DO UPDATE SET
        title = EXCLUDED.title, title_norm = EXCLUDED.title_norm,
        kind = EXCLUDED.kind, difficulty = EXCLUDED.difficulty,
        difficulty_score = EXCLUDED.difficulty_score,
        -- The company page's flag is only a placeholder until the body fetch
        -- writes the API's premium_required; never overwrite the API value.
        is_premium = CASE WHEN core.questions.body_fetched_at IS NULL
                          THEN EXCLUDED.is_premium ELSE core.questions.is_premium END,
        source_updated_at = COALESCE(EXCLUDED.source_updated_at, core.questions.source_updated_at),
        updated_at = now()
      RETURNING id, source_id`;
    for (const r of out) idBySource.set(r.source_id, r.id);
  }

  const links = dedupe(
    questions
      .filter((q) => idBySource.has(q.source_id))
      .map((q) => {
        const s = slugById.get(q.source_id);
        return {
          company_id: companyId,
          question_id: idBySource.get(q.source_id)!,
          asked_on: q.date_added,
          sort_order: q.sort_order,
          source_url: s ? `/problems/${q.source_id}/${s}` : null,
        };
      }),
    (r) => `${r.company_id}|${r.question_id}`,
  );
  for (const chunk of chunks(links, 500)) {
    await sql`INSERT INTO core.company_questions ${sql(chunk)}
      ON CONFLICT (company_id, question_id, coalesce(role_id, 0), coalesce(college_id, 0))
      DO UPDATE SET asked_on = EXCLUDED.asked_on, sort_order = EXCLUDED.sort_order`;
  }

  await upsertTopics(sql, questions, idBySource);
  return idBySource;
}

async function upsertTopics(sql: Sql, questions: any[], idBySource: Map<string, number>) {
  const names = [
    ...new Set(
      questions
        .flatMap((q) => (q.tags ?? []).map((t: string) => String(t).toLowerCase().trim()))
        .filter(Boolean),
    ),
  ];
  const topicId = new Map<string, number>();
  for (const chunk of chunks(names.map((name) => ({ name })), 500)) {
    const out = await sql`
      INSERT INTO core.topics ${sql(chunk)}
      ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id, name`;
    for (const r of out) topicId.set(r.name, r.id);
  }
  const links = dedupe(
    questions.flatMap((q) =>
      (q.tags ?? [])
        .map((t: string) => String(t).toLowerCase().trim())
        .filter((t: string) => t && topicId.has(t) && idBySource.has(q.source_id))
        .map((t: string) => ({
          question_id: idBySource.get(q.source_id)!,
          topic_id: topicId.get(t)!,
          source: 'source',
        })),
    ),
    (r) => `${r.question_id}|${r.topic_id}`,
  );
  for (const chunk of chunks(links, 500)) {
    await sql`INSERT INTO core.question_topics ${sql(chunk)} ON CONFLICT DO NOTHING`;
  }
}

/**
 * Upsert one question's full body (statement, code, mcq, options, images) from a
 * fromApiQuestion() row, and stamp body_fetched_at. This is the write that marks
 * a question "done" for the worklist -- done last, so a crash mid-way leaves the
 * row still pending rather than half-written-and-marked-done.
 */
export async function upsertBody(sql: Sql, questionId: number, row: any): Promise<void> {
  const st = row.body.problem_statement_md ?? row.body.problem_statement_html ?? '';
  await sql`
    UPDATE core.questions SET
      has_image = ${row.has_image},
      is_mock_oa = ${row.is_mock_oa},
      answers_locked = ${row.answers_locked ?? false},
      is_first_in_company = ${row.is_first_in_company ?? null},
      publication_status = ${row.publication_status ?? 'published'},
      content_hash = ${st ? hash(st) : null},
      source_created_at = COALESCE(${row.source_created_at ?? null}, source_created_at),
      source_updated_at = COALESCE(${row.source_updated_at ?? null}, source_updated_at),
      source_payload = ${row.source_payload ? sql.json(row.source_payload) : null},
      body_fetched_at = now(),
      updated_at = now()
    WHERE id = ${questionId}`;
  await writeBodyChildren(sql, questionId, row);
}

/** The body/code/mcq/options/images inserts, shared by both upsert entry points. */
async function writeBodyChildren(sql: Sql, questionId: number, row: any): Promise<void> {
  if (row.body_present) {
    await sql`
      INSERT INTO core.question_bodies (
        question_id, google_doc_link, statement_html, statement_md, editorial,
        input_test_case, output_test_case, hidden_test_cases_ref,
        hidden_test_cases_count, youtube_tutorial, visual_animation)
      VALUES (${questionId}, ${row.body.google_doc_link ?? null},
        ${row.body.problem_statement_html}, ${row.body.problem_statement_md},
        ${row.body.editorial}, ${row.body.input_test_case}, ${row.body.output_test_case},
        ${row.body.hidden_test_cases_ref}, ${row.body.hidden_test_cases_blob_count},
        ${row.body.youtube_tutorial}, ${row.body.visual_animation})
      ON CONFLICT (question_id) DO UPDATE SET
        statement_html = EXCLUDED.statement_html,
        statement_md = EXCLUDED.statement_md,
        editorial = EXCLUDED.editorial`;
  }

  const code = dedupe(
    (row.code ?? []).map((c: any) => ({ question_id: questionId, kind: c.kind, lang: c.lang, code: c.code })),
    (r) => `${r.kind}|${r.lang}`,
  );
  if (code.length) {
    await sql`INSERT INTO core.question_code ${sql(code)}
      ON CONFLICT (question_id, kind, lang) DO UPDATE SET code = EXCLUDED.code`;
  }

  const items = dedupe(
    (row.mcq_items ?? []).map((it: any) => ({
      question_id: questionId,
      mcq_index: it.mcq_index,
      stem: it.stem,
      selection_type: it.selection_type,
      solution_explanation: it.solution_explanation,
    })),
    (r) => String(r.mcq_index),
  );
  if (items.length) {
    await sql`INSERT INTO core.question_mcq_items ${sql(items)}
      ON CONFLICT (question_id, mcq_index) DO UPDATE SET
        stem = EXCLUDED.stem, solution_explanation = EXCLUDED.solution_explanation`;
  }

  const opts = dedupe(
    (row.mcq_options ?? []).map((o: any) => ({
      question_id: questionId,
      mcq_index: o.mcq_index,
      label: o.label,
      body: o.body,
      is_correct: o.is_correct,
    })),
    (r) => `${r.mcq_index}|${r.label}`,
  );
  if (opts.length) {
    await sql`INSERT INTO core.question_options ${sql(opts)}
      ON CONFLICT (question_id, mcq_index, label) DO UPDATE SET
        body = EXCLUDED.body, is_correct = EXCLUDED.is_correct`;
  }

  const imgs = dedupe(
    (row.images ?? []).map((im: any) => ({
      question_id: questionId,
      image_id: im.image_id,
      uploaded_at: im.uploaded_at,
      ordinal: im.ordinal,
    })),
    (r) => String(r.image_id),
  );
  if (imgs.length) {
    await sql`INSERT INTO core.question_images ${sql(imgs)}
      ON CONFLICT (question_id, image_id) DO UPDATE SET ordinal = EXCLUDED.ordinal`;
  }
}

/**
 * Upsert a question ENTIRELY from a get_question response (a fromApiQuestion
 * row): catalog fields, company + link, topics, and body -- in one call.
 *
 * This is what the body crawl uses, so it works for BOTH pre-catalogued rows
 * (company-page path already set the catalog fields; this just confirms them and
 * adds the body) AND sitemap-seeded bare rows (get_question is their only source
 * of title/company/topics, so this fills everything). Returns the question id.
 */
export async function upsertQuestionFromApi(sql: Sql, row: any): Promise<number> {
  // 1. Company, from whatever the payload carries (may be a company we never
  // saw on a company page -- e.g. the legacy questions belong to MAQ, ServiceNow).
  let companyId: number | null = null;
  if (row.company_slug || row.company_ref) {
    const [c] = await sql`
      INSERT INTO core.companies (slug, name, source_id, updated_at)
      VALUES (${row.company_slug ?? row.company_ref},
              ${row.company_name ?? row.company_slug ?? 'unknown'},
              ${row.company_ref ?? null}, now())
      ON CONFLICT (slug) DO UPDATE SET
        name = COALESCE(EXCLUDED.name, core.companies.name), updated_at = now()
      RETURNING id`;
    companyId = c.id;
  }

  // 2. The question itself: catalog fields AND body markers, body_fetched_at set.
  const kind = ENUM_KIND.has(row.qtype ?? '') ? row.qtype : row.qtype ? 'other' : null;
  const st = row.body.problem_statement_md ?? row.body.problem_statement_html ?? '';
  const [q] = await sql`
    INSERT INTO core.questions (
      slug, title, title_norm, kind, difficulty, difficulty_score, is_premium,
      has_image, is_mock_oa, answers_locked, is_first_in_company, publication_status,
      source_id, source_numeric_id, content_hash, body_fetched_at,
      source_created_at, source_updated_at, source_payload, updated_at)
    VALUES (
      ${row.title_norm?.replace(/\s+/g, '-') || row.source_id}, ${row.title},
      ${row.title_norm}, ${kind}, ${row.difficulty}, ${row.difficulty_score},
      ${row.premium_required}, ${row.has_image}, ${row.is_mock_oa},
      ${row.answers_locked ?? false}, ${row.is_first_in_company ?? null},
      ${row.publication_status ?? 'published'}, ${row.source_id}, ${row.numeric_id},
      ${st ? hash(st) : null}, now(), ${row.source_created_at ?? null},
      ${row.source_updated_at ?? null},
      ${row.source_payload ? sql.json(row.source_payload) : null}, now())
    ON CONFLICT (source_id) DO UPDATE SET
      title = EXCLUDED.title, title_norm = EXCLUDED.title_norm,
      kind = EXCLUDED.kind, difficulty = EXCLUDED.difficulty,
      difficulty_score = EXCLUDED.difficulty_score, is_premium = EXCLUDED.is_premium,
      has_image = EXCLUDED.has_image, is_mock_oa = EXCLUDED.is_mock_oa,
      answers_locked = EXCLUDED.answers_locked,
      publication_status = EXCLUDED.publication_status,
      content_hash = EXCLUDED.content_hash, body_fetched_at = now(),
      source_created_at = COALESCE(EXCLUDED.source_created_at, core.questions.source_created_at),
      source_updated_at = COALESCE(EXCLUDED.source_updated_at, core.questions.source_updated_at),
      source_payload = COALESCE(EXCLUDED.source_payload, core.questions.source_payload),
      updated_at = now()
    RETURNING id`;
  const questionId = q.id;

  // 3. Company link (M:N), 4. topics, 5. body -- reuse the existing writers.
  if (companyId) {
    await sql`
      INSERT INTO core.company_questions (company_id, question_id, role_raw, campus_type)
      VALUES (${companyId}, ${questionId}, ${row.role ?? null},
              ${ENUM_CAMPUS.has(row.campus_type ?? '') ? row.campus_type : null})
      ON CONFLICT (company_id, question_id, coalesce(role_id, 0), coalesce(college_id, 0))
      DO NOTHING`;
  }
  for (const t of row.tags ?? []) {
    const name = String(t).toLowerCase().trim();
    if (!name) continue;
    const [tp] = await sql`
      INSERT INTO core.topics (name) VALUES (${name})
      ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`;
    await sql`INSERT INTO core.question_topics (question_id, topic_id, source)
              VALUES (${questionId}, ${tp.id}, 'source') ON CONFLICT DO NOTHING`;
  }
  await writeBodyChildren(sql, questionId, row);
  return questionId;
}

/**
 * Upsert one interview experience from a parsed index/detail row (ExperienceRow
 * shape). Mirrors the bulk path in scripts/load.ts, so live and reload write the
 * same columns; the only difference is single-row vs batched.
 *
 * content_hash follows the same rule as questions: hash of company + opening
 * 500 chars of the narrative, so 526 known duplicate groups can be collapsed by
 * a later canonicalisation pass without losing rows.
 */
export async function upsertExperience(sql: Sql, e: any): Promise<void> {
  const row = {
    source_numeric_id: e.source_numeric_id,
    company_name_raw: e.company_name_raw,
    practice_company_key: e.practice_company_key ?? null,
    practice_company_ref: e.practice_company_ref ?? null,
    interview_date: e.interview_date,
    interview_date_raw: e.interview_date_raw ?? null,
    interview_type: e.interview_type,
    result_raw: e.result,
    difficulty_raw: e.difficulty_raw,
    rounds_raw: e.rounds,
    topics_asked: e.topics_asked,
    body_html: e.experience_html,
    status: e.status ?? 'approved',
    helpful_count: e.helpful_count ?? 0,
    has_questions: e.has_questions ?? false,
    oacoins_awarded: e.oacoins_awarded ?? null,
    proof_blob_path: e.proof_blob_path ?? null,
    reviewed_at: e.reviewed_at ?? null,
    automated_review_id: e.automated_review_id ?? null,
    content_hash: e.experience_html
      ? hash(String(e.company_name_raw).toLowerCase() + String(e.experience_html).slice(0, 500))
      : null,
    source_created_at: e.source_created_at ?? null,
    source_updated_at: e.source_updated_at ?? null,
    source_payload: sql.json(e.source_payload ?? e),
  };
  await sql`INSERT INTO core.interview_experiences ${sql(row)}
    ON CONFLICT (source_numeric_id) DO UPDATE SET
      body_html = EXCLUDED.body_html,
      helpful_count = EXCLUDED.helpful_count,
      content_hash = EXCLUDED.content_hash,
      practice_company_key = EXCLUDED.practice_company_key,
      source_updated_at = EXCLUDED.source_updated_at,
      source_payload = EXCLUDED.source_payload,
      updated_at = now()`;
}

export function dedupe<T>(rows: T[], key: (r: T) => string): T[] {
  const m = new Map<string, T>();
  for (const r of rows) m.set(key(r), r);
  return [...m.values()];
}

function* chunks<T>(rows: T[], size: number): Generator<T[]> {
  for (let i = 0; i < rows.length; i += size) yield rows.slice(i, i + size);
}
