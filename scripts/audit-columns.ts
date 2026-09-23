/**
 * For every column in the applied schema: do we have data, is it derived work we
 * have not done yet, or is it simply unavailable from scraping?
 */
import { readFileSync } from 'node:fs';

const bodies = ['accenture', 'amazon'].flatMap(
  (s) => JSON.parse(readFileSync(`data/slice_${s}/bodies_api.json`, 'utf8')) as any[],
);
const qs = ['accenture', 'amazon'].flatMap(
  (s) => JSON.parse(readFileSync(`data/slice_${s}/questions.json`, 'utf8')) as any[],
);
const comps = ['accenture', 'amazon'].map(
  (s) => JSON.parse(readFileSync(`data/slice_${s}/company.json`, 'utf8')),
);
const exps = JSON.parse(readFileSync('data/experiences_all.json', 'utf8')) as any[];

const pct = (n: number, d: number) => `${((100 * n) / d).toFixed(0)}%`;
const have = (rows: any[], f: (r: any) => unknown) =>
  rows.filter((r) => {
    const v = f(r);
    return v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && !v.length);
  }).length;

type Row = [string, string, string];
const out: Row[] = [];
const add = (col: string, status: string, note: string) => out.push([col, status, note]);

// --- core.companies
add('companies.slug/name/source_id', 'HAVE', `${comps.length}/2 fetched (455 available)`);
add('companies.logo_url', 'MISSING', 'served by /api/brand-logo, never scraped');
add('companies.solutions_available', 'HAVE', 'on the company payload');

// --- core.questions
add('questions.title/slug/kind', 'HAVE', `${have(bodies, (b) => b.title)}/${bodies.length}`);
add('questions.difficulty', 'PARTIAL', `${pct(have(bodies, (b) => b.difficulty), bodies.length)} — only where the source states it (no longer inferred)`);
add('questions.difficulty_score', 'HAVE', pct(have(bodies, (b) => b.difficulty_score), bodies.length));
add('questions.is_premium/has_image', 'HAVE', '100%');
add('questions.source_id/source_numeric_id', 'HAVE', '100%');
add('questions.content_hash', 'TODO', 'derivation pass not written');
add('questions.canonical_id/merge_method', 'TODO', 'dedupe pass not run — 264 dupes known to exist');

// --- bodies / code / mcq
add('question_bodies.statement_md', 'HAVE', pct(have(bodies, (b) => b.body.problem_statement_md), bodies.length));
add('question_bodies.editorial', 'PARTIAL', pct(have(bodies, (b) => b.body.editorial), bodies.length));
add('question_bodies.input/output_test_case', 'PARTIAL', pct(have(bodies, (b) => b.body.input_test_case), bodies.length) + ' (coding/sql only)');
add('question_bodies.hidden_test_cases_ref', 'SPARSE', `${have(bodies, (b) => b.body.hidden_test_cases_ref)} rows only`);
add('question_bodies.youtube/visual_animation', 'EMPTY', '0 rows — column exists upstream, never populated');
add('question_code.*', 'HAVE', `${bodies.reduce((a, b) => a + b.code.length, 0)} rows`);
add('question_mcq_items/options', 'HAVE', `${bodies.reduce((a, b) => a + b.mcq_options.length, 0)} options`);

// --- topics
add('topics.name', 'HAVE', `${new Set(qs.flatMap((q) => q.tags)).size} distinct`);
add('topics.alias_of', 'TODO', 'canonicalisation pass not run');
add('question_topics.source', 'HAVE', "defaults to 'source'");

// --- company_questions
add('company_questions.company/question', 'HAVE', `${qs.length} links`);
add('company_questions.role_id/college_id', 'TODO', 'raw strings held; lookup tables not built');
add('company_questions.campus_type', 'PARTIAL', pct(have(bodies, (b) => b.campus_type), bodies.length));
add('company_questions.asked_on', 'HAVE', pct(have(qs, (q) => q.date_added), qs.length));

// --- experiences
add('interview_experiences.body_html', 'HAVE', `${have(exps, (e) => e.experience_html)}/${exps.length}`);
add('interview_experiences.company_name_raw', 'HAVE', '100%');
add('interview_experiences.company_id', 'TODO', `only ${pct(have(exps, (e) => e.practice_company_key), exps.length)} have a key; aliases unbuilt`);
add('interview_experiences.result_raw', 'HAVE', '100% (496 distinct values)');
add('interview_experiences.result', 'TODO', 'normalisation not written');
add('interview_experiences.rounds_raw', 'HAVE', pct(have(exps, (e) => e.rounds), exps.length));
add('interview_experiences.rounds_count', 'TODO', 'extractable from ~252 numeric rows');
add('interview_experiences.interview_date', 'PARTIAL', pct(have(exps, (e) => e.interview_date), exps.length));
add('interview_experiences.interview_date_raw', 'LOST', 'parser already overwrote it — needs a re-parse from snapshots');
add('interview_experiences.date_is_ambiguous', 'TODO', 'flag not computed');
add('interview_experiences.content_hash/canonical_id', 'TODO', '526 duplicate groups known');
add('interview_experiences.author_user_id', 'MISSING', 'not exposed by the site');
add('experience_topics.*', 'TODO', 'needs the LLM normalisation pass');

// --- ingest
add('ingest.raw_pages.*', 'HAVE', `${readFileSync('data/raw_pages.ndjson', 'utf8').trim().split('\n').length} rows`);
add('ingest.source_counts.*', 'TODO', 'counts observed but never recorded as rows');

const w = Math.max(...out.map((r) => r[0].length));
const order = ['HAVE', 'PARTIAL', 'SPARSE', 'EMPTY', 'TODO', 'LOST', 'MISSING'];
for (const status of order) {
  const rows = out.filter((r) => r[1] === status);
  if (!rows.length) continue;
  console.log(`\n${status}`);
  for (const [c, , n] of rows) console.log(`  ${c.padEnd(w)}  ${n}`);
}
const counts = order.map((s) => `${s}=${out.filter((r) => r[1] === s).length}`).join('  ');
console.log(`\n${counts}`);
