import { parsePage, decodeId } from '../flight.ts';
import { toTags, toBool, toInt, toDifficulty, toText, normTitle } from '../normalize.ts';

export type ProblemRow = {
  source_id: string;
  numeric_id: number | null;
  title: string;
  title_norm: string;
  qtype: string | null;
  difficulty: string | null;
  difficulty_score: number | null;
  premium_required: boolean;
  has_image: boolean;
  is_mock_oa: boolean;
  publication_status: string | null;
  company_slug: string | null;
  company_name: string | null;
  company_ref: string | null;
  role: string | null;
  college_name: string | null;
  campus_type: string | null;
  tags: string[];
  source_created_at: string | null;
  source_updated_at: string | null;
  /** false when the page returned metadata only -- i.e. we were not logged in. */
  body_present: boolean;
  body: {
    problem_statement_html: string | null;
    problem_statement_md: string | null;
    editorial: string | null;
    input_test_case: string | null;
    output_test_case: string | null;
    hidden_test_cases_ref: string | null;
    hidden_test_cases_blob_count: number | null;
    visual_animation: string | null;
    youtube_tutorial: string | null;
    google_doc_link: string | null;
  };
  /** kind+lang+code; replaces the site's 11 flat nullable columns. */
  code: { kind: string; lang: string; code: string }[];
};

const CODE_FIELDS: [string, string, string][] = [
  ['solution', 'generic', 'solution'],
  ['solution', 'generic_code', 'solution_code'],
  ['solution', 'cpp', 'solution_cpp'],
  ['solution', 'python', 'solution_python'],
  ['solution', 'java', 'solution_java'],
  ['solution', 'sql', 'sql_solution'],
  ['solution', 'bash', 'bash_solution'],
  ['solution', 'js', 'js_solution'],
  ['solution', 'prompt', 'prompt_solution'],
  ['pregiven', 'generic', 'pregiven_code'],
  ['pregiven', 'cpp', 'pregiven_code_cpp'],
  ['pregiven', 'python', 'pregiven_code_python'],
  ['pregiven', 'java', 'pregiven_code_java'],
];

/** Parse /problems/<id>/<slug>. Works logged out (metadata only) or in (full). */
export function parseProblemPage(html: string): ProblemRow {
  const p = parsePage(html);
  const q = p.get('initialQuestion') as Record<string, unknown> | undefined;
  if (!q) throw new Error('initialQuestion missing -- page shape changed');

  const md = toText(q.md_problem_statement);
  const htmlStmt = toText(q.problem_statement);

  const code = CODE_FIELDS.flatMap(([kind, lang, field]) => {
    const v = toText(q[field]);
    return v ? [{ kind, lang, code: v }] : [];
  });

  return {
    source_id: String(q.id),
    numeric_id: decodeId(String(q.id)),
    title: String(q.title),
    title_norm: normTitle(String(q.title)),
    qtype: q.question_type ? String(q.question_type) : null,
    difficulty: toDifficulty(q.difficulty),
    difficulty_score: toInt(q.difficulty_score),
    premium_required: toBool(q.premium_required),
    has_image: toBool(q.has_image),
    is_mock_oa: toBool(q.is_mock_oa),
    publication_status: q.publication_status ? String(q.publication_status) : null,
    company_slug: q.unique_company_name ? String(q.unique_company_name) : null,
    company_name: q.company_name ? String(q.company_name) : null,
    company_ref: q.company_ref ? String(q.company_ref) : null,
    role: toText(q.role),
    college_name: toText(q.college_name),
    campus_type: toText(q.campus_type),
    tags: toTags(q.lc_tags),
    source_created_at: q.created_at ? String(q.created_at) : null,
    source_updated_at: q.updated_at ? String(q.updated_at) : null,
    body_present: Boolean(md || htmlStmt),
    body: {
      problem_statement_html: htmlStmt,
      problem_statement_md: md,
      editorial: toText(q.editorial),
      input_test_case: toText(q.input_test_case),
      output_test_case: toText(q.output_test_case),
      hidden_test_cases_ref: toText(q.hidden_test_cases_ref),
      hidden_test_cases_blob_count: toInt(q.hidden_test_cases_blob_count),
      visual_animation: toText(q.visual_animation),
      youtube_tutorial: toText(q.youtube_tutorial),
      google_doc_link: toText(q.google_doc_link),
    },
    code,
  };
}
