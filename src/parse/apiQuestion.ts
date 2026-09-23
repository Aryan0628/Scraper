import { decodeId } from '../flight.ts';
import { toTags, toBool, toInt, toDifficulty, toText, normTitle } from '../normalize.ts';

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

export type McqOption = { mcq_index: number; label: string; body: string; is_correct: boolean };

/** Normalise an /api/proxy/question response into our row shape. */
export function fromApiQuestion(
  d: Record<string, any>,
  mcqItems: any[] = [],
  images: { id: number; uploaded_at: string }[] = [],
  answersLocked = false,
) {
  const code = CODE_FIELDS.flatMap(([kind, lang, f]) => {
    const v = toText(d[f]);
    return v ? [{ kind, lang, code: v }] : [];
  });

  const items = mcqItems.map((it) => ({
    mcq_index: toInt(it.mcq_index) ?? 1,
    stem: toText(it.stem),
    selection_type: toText(it.selection_type),
    solution_explanation: toText(it.solution_explanation),
  }));

  const options: McqOption[] = [];
  for (const it of mcqItems) {
    const correct: string[] = Array.isArray(it.correct_option_letters)
      ? it.correct_option_letters.map((x: any) => String(x).toUpperCase())
      : [];
    for (let i = 1; i <= 8; i++) {
      const body = toText(it[`option_${i}`]);
      if (!body) continue;
      const label = String.fromCharCode(64 + i); // 1 -> A
      options.push({
        mcq_index: toInt(it.mcq_index) ?? 1,
        label,
        body,
        is_correct: correct.includes(label),
      });
    }
  }

  const md = toText(d.md_problem_statement);
  const html = toText(d.problem_statement);

  return {
    source_id: String(d.id),
    numeric_id: decodeId(String(d.id)),
    title: String(d.title ?? ''),
    title_norm: normTitle(String(d.title ?? '')),
    qtype: toText(d.question_type),
    difficulty: toDifficulty(d.difficulty),
    difficulty_score: toInt(d.difficulty_score),
    premium_required: toBool(d.premium_required),
    has_image: toBool(d.has_image),
    is_mock_oa: toBool(d.is_mock_oa),
    publication_status: toText(d.publication_status),
    company_slug: toText(d.unique_company_name),
    company_name: toText(d.company_name),
    company_ref: toText(d.company_ref),
    role: toText(d.role),
    college_name: toText(d.college_name),
    campus_type: toText(d.campus_type),
    tags: toTags(d.lc_tags),
    is_first_in_company: d.is_first_in_company === true,
    source_created_at: d.created_at ? String(d.created_at) : null,
    source_updated_at: d.updated_at ? String(d.updated_at) : null,
    // Keep the payload verbatim. Normalised fields above are a projection of
    // this, not a replacement: anything we failed to model is still recoverable
    // without spending another request against the 150/hour cap.
    source_payload: d,
    body_present: Boolean(md || html),
    body: {
      google_doc_link: toText(d.google_doc_link),
      problem_statement_html: html,
      problem_statement_md: md,
      editorial: toText(d.editorial),
      input_test_case: toText(d.input_test_case),
      output_test_case: toText(d.output_test_case),
      hidden_test_cases_ref: toText(d.hidden_test_cases_ref),
      hidden_test_cases_blob_count: toInt(d.hidden_test_cases_blob_count),
      visual_animation: toText(d.visual_animation),
      youtube_tutorial: toText(d.youtube_tutorial),
    },
    code,
    // true when the source refused the answer key because this is a mock-OA
    // question. Distinguishes "no options exist" from "options withheld".
    answers_locked: answersLocked,
    mcq_items: items,
    mcq_options: options,
    images: images.map((im, i) => ({
      image_id: im.id,
      uploaded_at: im.uploaded_at ?? null,
      ordinal: i + 1,
    })),
  };
}
