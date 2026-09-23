/** Does the schema have a home for every field the source actually gives us? */
import { readFileSync } from 'node:fs';

const schema = readFileSync('src/db/002_core.sql', 'utf8');
const hasCol = (c: string) => new RegExp(`^\\s+${c}\\s`, 'm').test(schema);

// Every key observed on a real /api/proxy/question payload.
const QUESTION_FIELDS = [
  'id', 'title', 'google_doc_link', 'problem_statement', 'md_problem_statement',
  'solution', 'solution_code', 'solution_cpp', 'solution_python', 'solution_java',
  'sql_solution', 'bash_solution', 'js_solution', 'prompt_solution',
  'pregiven_code', 'pregiven_code_cpp', 'pregiven_code_python', 'pregiven_code_java',
  'input_test_case', 'output_test_case', 'hidden_test_cases_ref', 'hidden_test_cases_blob_count',
  'difficulty', 'difficulty_score', 'question_type', 'premium_required',
  'lc_tags', 'visual_animation', 'youtube_tutorial', 'editorial',
  'created_at', 'updated_at', 'unique_company_name', 'company_name', 'company_ref',
  'campus_type', 'college_name', 'role', 'is_mock_oa', 'publication_status',
  'has_image', 'is_first_in_company',
];
const COMPANY_FIELDS = [
  'id', 'name', 'unique_company_name', 'date', 'solutions_available',
  'created_at', 'updated_at', 'question_count', 'free_question_count',
  'premium_question_count', 'has_free_questions', 'premium_only',
  'recent_questions', 'question_types', 'roles', 'colleges', 'campus_types',
];
const EXPERIENCE_FIELDS = [
  'id', 'company', 'role', 'college', 'interview_date', 'interview_type', 'result',
  'difficulty', 'rounds', 'topics_asked', 'experience', 'status', 'oacoins_awarded',
  'created_at', 'updated_at', 'proof_blob_path', 'reviewed_at', 'automated_review_id',
  'timestamp', 'has_questions', 'practice_company_key', 'practice_company_ref',
  'helpful_count',
];

// Where each source field is expected to land (column name, or a note).
const MAP: Record<string, string> = {
  // handled structurally, not as a column
  solution: 'question_code', solution_code: 'question_code', solution_cpp: 'question_code',
  solution_python: 'question_code', solution_java: 'question_code', sql_solution: 'question_code',
  bash_solution: 'question_code', js_solution: 'question_code', prompt_solution: 'question_code',
  pregiven_code: 'question_code', pregiven_code_cpp: 'question_code',
  pregiven_code_python: 'question_code', pregiven_code_java: 'question_code',
  lc_tags: 'question_topics', problem_statement: 'statement_html',
  md_problem_statement: 'statement_md', question_type: 'kind',
  premium_required: 'is_premium', id: 'source_id', unique_company_name: 'company_questions',
  company_name: 'company_questions', company_ref: 'company_questions',
  hidden_test_cases_blob_count: 'hidden_test_cases_count',
  roles: 'roles table', colleges: 'colleges table', campus_types: 'company_questions',
  question_types: 'derivable from questions.kind',
  question_count: 'company_stats', free_question_count: 'company_stats',
  premium_question_count: 'company_stats',
  college_name: 'college_raw', role: 'role_raw',
  company: 'company_name_raw', experience: 'body_html', result: 'result_raw',
  difficulty: 'difficulty / difficulty_raw', rounds: 'rounds_raw',
  interview_date: 'interview_date',
};

const report = (label: string, fields: string[]) => {
  const lost: string[] = [];
  for (const f of fields) {
    const target = MAP[f] ?? f;
    if (target.includes(' ') || target.includes('_table')) continue; // structural
    if (hasCol(target) || schema.includes(target)) continue;
    lost.push(f);
  }
  console.log(`\n${label} -- ${fields.length} source fields, ${lost.length} with NO home:`);
  for (const l of lost) console.log(`   DROPPED: ${l}`);
  if (!lost.length) console.log('   (all mapped)');
};

report('questions', QUESTION_FIELDS);
report('companies', COMPANY_FIELDS);
report('interview_experiences', EXPERIENCE_FIELDS);

console.log('\n--- source timestamps ---');
for (const c of ['source_created_at', 'source_updated_at']) {
  console.log(`  ${c}: ${hasCol(c) ? 'present' : 'ABSENT -- source timestamps overwritten by ours'}`);
}
