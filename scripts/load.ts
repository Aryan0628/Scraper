/**
 * Load scraped slices into Postgres.
 *
 * Bulk-upserts: every table is written with ONE multi-row statement per chunk
 * rather than one statement per row. That matters because each round-trip to
 * Neon costs 100-500ms depending on region -- a per-row loader spends ~500
 * round-trips on a single 34-question company, which does not scale to 455.
 *
 * Idempotent: every write upserts on a natural key, so re-running is safe.
 * Columns needing a derivation pass (canonical_id, company_id on experiences,
 * normalised result, role/college lookups) are nullable and left NULL here.
 *
 *   node --env-file=.env scripts/load.ts [--company=cisco] [--skip-experiences]
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set (see .env.example)');
  process.exit(1);
}
const only = process.argv.find((a) => a.startsWith('--company='))?.split('=')[1];
const skipExp = process.argv.includes('--skip-experiences');

const sql = postgres(url, {
  onnotice: () => {},
  max: 4,
  idle_timeout: 5,
  max_lifetime: 60,
  prepare: false,
});

const read = <T>(p: string): T | null =>
  existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as T) : null;
const slugs = only
  ? [only]
  : readdirSync('data').filter((d) => d.startsWith('slice_')).map((d) => d.slice(6));

// Problem slugs live in the sitemap URL, not in the payload.
const sitemap = read<string[]>('data/sitemap_urls.json') ?? [];
const slugById = new Map<string, string>();
for (const u of sitemap) {
  const m = /^\/problems\/([^/]+)\/(.+)$/.exec(u);
  if (m) slugById.set(m[1], m[2]);
}

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const ENUM_KIND = new Set(['coding', 'mcq', 'sql', 'subjective', 'other']);
const ENUM_CAMPUS = new Set(['on_campus', 'off_campus']);
const CHUNK = 500;

/**
 * A single INSERT cannot touch the same conflict target twice ("ON CONFLICT DO
 * UPDATE command cannot affect row a second time"), so every batch is deduped
 * on its natural key first. Last occurrence wins.
 */
function dedupe<T>(rows: T[], key: (r: T) => string): T[] {
  const m = new Map<string, T>();
  for (const r of rows) m.set(key(r), r);
  return [...m.values()];
}

async function chunked<T>(rows: T[], fn: (chunk: T[]) => Promise<unknown>): Promise<number> {
  for (let i = 0; i < rows.length; i += CHUNK) await fn(rows.slice(i, i + CHUNK));
  return rows.length;
}

const counts: Record<string, number> = {};
const bump = (k: string, n: number) => (counts[k] = (counts[k] ?? 0) + n);

for (const slug of slugs) {
  const dir = `data/slice_${slug}`;
  const company = read<any>(`${dir}/company.json`);
  const questions = read<any[]>(`${dir}/questions.json`) ?? [];
  const bodies = read<any[]>(`${dir}/bodies_api.json`) ?? read<any[]>(`${dir}/bodies.json`) ?? [];
  if (!company) continue;

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
    RETURNING id, name`;
  bump('companies', 1);

  // The source's own counts are recorded as observations, never as truth --
  // they have already drifted (Amazon declares 46 premium, 42 rows carry it).
  const sourceCounts = (
    [
      ['question_count', company.question_count],
      ['free_question_count', company.free_question_count],
      ['premium_question_count', company.premium_question_count],
    ] as [string, number | null][]
  )
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([metric, value]) => ({ scope: 'company', scope_key: company.slug, metric, value }));
  if (sourceCounts.length) {
    await sql`INSERT INTO ingest.source_counts ${sql(sourceCounts)} ON CONFLICT DO NOTHING`;
  }

  const bodyBySource = new Map(bodies.map((b) => [b.source_id, b]));

  // ---- 1. questions, one statement, id map comes back via RETURNING --------
  const qRows = dedupe(
    questions.map((q) => {
      const b = bodyBySource.get(q.source_id);
      const statement = b?.body?.problem_statement_md ?? b?.body?.problem_statement_html ?? '';
      return {
        slug: slugById.get(q.source_id) ?? q.title_norm.replace(/\s+/g, '-'),
        title: q.title,
        title_norm: q.title_norm,
        kind: ENUM_KIND.has(q.qtype ?? '') ? q.qtype : q.qtype ? 'other' : null,
        difficulty: q.difficulty,
        difficulty_score: q.difficulty_score,
        // API flag when we have the body; the company page's only as a placeholder.
        is_premium: b ? Boolean(b.premium_required) : q.premium_required,
        has_image: b?.has_image ?? false,
        publication_status: b?.publication_status ?? 'published',
        is_mock_oa: b?.is_mock_oa ?? false,
        answers_locked: b?.answers_locked ?? false,
        is_first_in_company: b?.is_first_in_company ?? null,
        source_id: q.source_id,
        source_numeric_id: q.numeric_id,
        content_hash: statement ? hash(statement) : null,
        body_fetched_at: b?.body_present ? new Date() : null,
        source_created_at: b?.source_created_at ?? null,
        source_updated_at: b?.source_updated_at ?? q.source_updated_at ?? null,
        source_payload: b?.source_payload ? sql.json(b.source_payload) : null,
      };
    }),
    (r) => r.source_id,
  );

  const idBySource = new Map<string, number>();
  await chunked(qRows, async (chunk) => {
    const out = await sql`
      INSERT INTO core.questions ${sql(chunk)}
      ON CONFLICT (source_id) DO UPDATE SET
        title = EXCLUDED.title, title_norm = EXCLUDED.title_norm,
        kind = EXCLUDED.kind, difficulty = EXCLUDED.difficulty,
        difficulty_score = EXCLUDED.difficulty_score,
        is_premium = CASE WHEN EXCLUDED.body_fetched_at IS NOT NULL OR core.questions.body_fetched_at IS NULL
                          THEN EXCLUDED.is_premium ELSE core.questions.is_premium END,
        is_mock_oa = CASE WHEN EXCLUDED.body_fetched_at IS NOT NULL
                          THEN EXCLUDED.is_mock_oa ELSE core.questions.is_mock_oa END,
        answers_locked = EXCLUDED.answers_locked,
        content_hash = COALESCE(EXCLUDED.content_hash, core.questions.content_hash),
        body_fetched_at = COALESCE(EXCLUDED.body_fetched_at, core.questions.body_fetched_at),
        source_created_at = COALESCE(EXCLUDED.source_created_at, core.questions.source_created_at),
        source_updated_at = COALESCE(EXCLUDED.source_updated_at, core.questions.source_updated_at),
        source_payload = COALESCE(EXCLUDED.source_payload, core.questions.source_payload),
        updated_at = now()
      RETURNING id, source_id`;
    for (const r of out) idBySource.set(r.source_id, r.id);
  });
  bump('questions', qRows.length);

  const qid = (sourceId: string) => idBySource.get(sourceId);

  // ---- 2. company <-> question links --------------------------------------
  const links = dedupe(
    questions
      .filter((q) => qid(q.source_id))
      .map((q) => {
        const b = bodyBySource.get(q.source_id);
        const s = slugById.get(q.source_id);
        return {
          company_id: c.id,
          question_id: qid(q.source_id)!,
          role_raw: b?.role ?? null,
          college_raw: b?.college_name ?? null,
          campus_type: ENUM_CAMPUS.has(b?.campus_type ?? '') ? b.campus_type : null,
          asked_on: q.date_added,
          sort_order: q.sort_order,
          source_url: s ? `/problems/${q.source_id}/${s}` : null,
        };
      }),
    (r) => `${r.company_id}|${r.question_id}`,
  );
  await chunked(links, (chunk) =>
    sql`INSERT INTO core.company_questions ${sql(chunk)}
        ON CONFLICT (company_id, question_id, coalesce(role_id, 0), coalesce(college_id, 0))
        DO UPDATE SET asked_on = EXCLUDED.asked_on, sort_order = EXCLUDED.sort_order,
                      role_raw = EXCLUDED.role_raw, college_raw = EXCLUDED.college_raw`);
  bump('company_questions', links.length);

  // ---- 3. topics, then question<->topic ------------------------------------
  const topicNames = [
    ...new Set(questions.flatMap((q) => (q.tags ?? []).map((t: string) => String(t).toLowerCase().trim())).filter(Boolean)),
  ];
  const topicId = new Map<string, number>();
  if (topicNames.length) {
    await chunked(topicNames.map((name) => ({ name })), async (chunk) => {
      const out = await sql`
        INSERT INTO core.topics ${sql(chunk)}
        ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
        RETURNING id, name`;
      for (const r of out) topicId.set(r.name, r.id);
    });
  }
  bump('topics', topicNames.length);

  const topicLinks = dedupe(
    questions.flatMap((q) =>
      (q.tags ?? [])
        .map((t: string) => String(t).toLowerCase().trim())
        .filter((t: string) => t && topicId.has(t) && qid(q.source_id))
        .map((t: string) => ({
          question_id: qid(q.source_id)!,
          topic_id: topicId.get(t)!,
          source: 'source',
        })),
    ),
    (r) => `${r.question_id}|${r.topic_id}`,
  );
  await chunked(topicLinks, (chunk) =>
    sql`INSERT INTO core.question_topics ${sql(chunk)} ON CONFLICT DO NOTHING`);
  bump('question_topics', topicLinks.length);

  // ---- 4. bodies, code, mcq items, options, images -------------------------
  const withBody = bodies.filter((b) => b.body_present && qid(b.source_id));

  const bodyRows = dedupe(
    withBody.map((b) => ({
      question_id: qid(b.source_id)!,
      google_doc_link: b.body.google_doc_link ?? null,
      statement_html: b.body.problem_statement_html,
      statement_md: b.body.problem_statement_md,
      editorial: b.body.editorial,
      input_test_case: b.body.input_test_case,
      output_test_case: b.body.output_test_case,
      hidden_test_cases_ref: b.body.hidden_test_cases_ref,
      hidden_test_cases_count: b.body.hidden_test_cases_blob_count,
      youtube_tutorial: b.body.youtube_tutorial,
      visual_animation: b.body.visual_animation,
    })),
    (r) => String(r.question_id),
  );
  await chunked(bodyRows, (chunk) =>
    sql`INSERT INTO core.question_bodies ${sql(chunk)}
        ON CONFLICT (question_id) DO UPDATE SET
          statement_html = EXCLUDED.statement_html,
          statement_md = EXCLUDED.statement_md,
          editorial = EXCLUDED.editorial`);
  bump('question_bodies', bodyRows.length);

  const codeRows = dedupe(
    withBody.flatMap((b) =>
      (b.code ?? []).map((cd: any) => ({
        question_id: qid(b.source_id)!,
        kind: cd.kind,
        lang: cd.lang,
        code: cd.code,
      })),
    ),
    (r) => `${r.question_id}|${r.kind}|${r.lang}`,
  );
  await chunked(codeRows, (chunk) =>
    sql`INSERT INTO core.question_code ${sql(chunk)}
        ON CONFLICT (question_id, kind, lang) DO UPDATE SET code = EXCLUDED.code`);
  bump('question_code', codeRows.length);

  // Items must land before options: options carry a composite FK to them.
  const itemRows = dedupe(
    withBody.flatMap((b) =>
      (b.mcq_items ?? []).map((it: any) => ({
        question_id: qid(b.source_id)!,
        mcq_index: it.mcq_index,
        stem: it.stem,
        selection_type: it.selection_type,
        solution_explanation: it.solution_explanation,
      })),
    ),
    (r) => `${r.question_id}|${r.mcq_index}`,
  );
  await chunked(itemRows, (chunk) =>
    sql`INSERT INTO core.question_mcq_items ${sql(chunk)}
        ON CONFLICT (question_id, mcq_index) DO UPDATE SET
          stem = EXCLUDED.stem,
          solution_explanation = EXCLUDED.solution_explanation`);
  bump('question_mcq_items', itemRows.length);

  const optRows = dedupe(
    withBody.flatMap((b) =>
      (b.mcq_options ?? []).map((o: any) => ({
        question_id: qid(b.source_id)!,
        mcq_index: o.mcq_index,
        label: o.label,
        body: o.body,
        is_correct: o.is_correct,
      })),
    ),
    (r) => `${r.question_id}|${r.mcq_index}|${r.label}`,
  );
  await chunked(optRows, (chunk) =>
    sql`INSERT INTO core.question_options ${sql(chunk)}
        ON CONFLICT (question_id, mcq_index, label) DO UPDATE SET
          body = EXCLUDED.body, is_correct = EXCLUDED.is_correct`);
  bump('question_options', optRows.length);

  const imgRows = dedupe(
    withBody.flatMap((b) =>
      (b.images ?? []).map((im: any) => ({
        question_id: qid(b.source_id)!,
        image_id: im.image_id,
        uploaded_at: im.uploaded_at,
        ordinal: im.ordinal,
      })),
    ),
    (r) => `${r.question_id}|${r.image_id}`,
  );
  await chunked(imgRows, (chunk) =>
    sql`INSERT INTO core.question_images ${sql(chunk)}
        ON CONFLICT (question_id, image_id) DO UPDATE SET ordinal = EXCLUDED.ordinal`);
  bump('question_images', imgRows.length);

  console.log(`${c.name}: ${qRows.length} questions, ${bodyRows.length} bodies`);
}

// ---------------------------------------------------------------- experiences
if (skipExp) {
  console.log('skipping interview experiences (--skip-experiences)');
} else {
  const exps = read<any[]>('data/experiences_all.json') ?? [];
  const expRows = dedupe(
    exps.map((e) => ({
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
      source_payload: sql.json(e),
    })),
    (r) => String(r.source_numeric_id),
  );
  await chunked(expRows, (chunk) =>
    sql`INSERT INTO core.interview_experiences ${sql(chunk)}
        ON CONFLICT (source_numeric_id) DO UPDATE SET
          body_html = EXCLUDED.body_html,
          helpful_count = EXCLUDED.helpful_count,
          content_hash = EXCLUDED.content_hash,
          practice_company_key = EXCLUDED.practice_company_key,
          source_updated_at = EXCLUDED.source_updated_at,
          source_payload = EXCLUDED.source_payload,
          updated_at = now()`);
  bump('interview_experiences', expRows.length);
}

// ------------------------------------------------------------------ provenance
if (existsSync('data/raw_pages.ndjson')) {
  const rows = dedupe(
    readFileSync('data/raw_pages.ndjson', 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
      .map((p) => ({
        content_hash: p.content_hash,
        url: p.url,
        kind: p.kind,
        http_status: p.http_status,
        fetched_at: p.fetched_at,
        path: p.path,
        byte_size: p.byte_size,
        authenticated: p.authenticated,
      })),
    (r) => r.content_hash,
  );
  await chunked(rows, (chunk) =>
    sql`INSERT INTO ingest.raw_pages ${sql(chunk)} ON CONFLICT (content_hash) DO NOTHING`);
  bump('raw_pages', rows.length);
}

await sql`REFRESH MATERIALIZED VIEW core.company_stats`;

console.log('\nwritten:');
for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(22)} ${v}`);

const [{ count: qc }] = await sql`SELECT count(*)::int FROM core.questions`;
const [{ count: oc }] = await sql`SELECT count(*)::int FROM core.question_options`;
const [{ count: ec }] = await sql`SELECT count(*)::int FROM core.interview_experiences`;
console.log(`\nin db: questions=${qc} options=${oc} experiences=${ec}`);
await sql.end({ timeout: 5 });
process.exit(0);
