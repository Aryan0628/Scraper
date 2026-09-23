import { parsePage, decodeId } from '../flight.ts';
import { toTags, toBool, toInt, toDifficulty, toDate, normTitle } from '../normalize.ts';

export type CompanyRow = {
  source_id: string;
  slug: string;
  name: string;
  question_count: number | null;
  free_question_count: number | null;
  premium_question_count: number | null;
  solutions_available: boolean;
  premium_only: boolean;
  roles: string[];
  colleges: string[];
  campus_types: string[];
  question_types: string[];
  source_created_at: string | null;
  source_updated_at: string | null;
};

export type CatalogQuestionRow = {
  source_id: string;
  numeric_id: number | null;
  title: string;
  title_norm: string;
  qtype: string | null;
  difficulty: string | null;
  difficulty_score: number | null;
  premium_required: boolean;
  tags: string[];
  company_ref: string;
  sort_order: number | null;
  date_added: string | null;
};

/** Parse /company-questions/<slug>. Yields the company plus its whole catalog. */
export function parseCompanyPage(html: string) {
  const p = parsePage(html);
  const c = p.get('initialCompany') as Record<string, unknown> | undefined;
  const qs = (p.get('initialQuestions') as Record<string, unknown>[] | undefined) ?? [];
  if (!c) throw new Error('initialCompany missing -- page shape changed');

  const company: CompanyRow = {
    source_id: String(c.id),
    slug: String(c.unique_company_name),
    name: String(c.name),
    question_count: toInt(c.question_count),
    free_question_count: toInt(c.free_question_count),
    premium_question_count: toInt(c.premium_question_count),
    solutions_available: toBool(c.solutions_available),
    premium_only: toBool(c.premium_only),
    roles: (c.roles as string[]) ?? [],
    colleges: (c.colleges as string[]) ?? [],
    campus_types: (c.campus_types as string[]) ?? [],
    question_types: (c.question_types as string[]) ?? [],
    source_created_at: c.created_at ? String(c.created_at) : null,
    source_updated_at: c.updated_at ? String(c.updated_at) : null,
  };

  const questions: CatalogQuestionRow[] = qs.map((q) => ({
    source_id: String(q.id),
    numeric_id: decodeId(String(q.id)),
    title: String(q.title),
    title_norm: normTitle(String(q.title)),
    qtype: q.question_type ? String(q.question_type) : null,
    difficulty: toDifficulty(q.difficulty),
    difficulty_score: toInt(q.difficulty_score),
    premium_required: toBool(q.premium_required),
    tags: toTags(q.lc_tags),
    company_ref: String(q.company_ref ?? c.id),
    sort_order: toInt(q.sort_order),
    date_added: toDate(q.date_added),
  }));

  // The page states its own total; a mismatch means we parsed a truncated list.
  const declared = company.question_count;
  if (declared !== null && declared !== questions.length) {
    throw new Error(
      `count mismatch for ${company.slug}: page declares ${declared}, parsed ${questions.length}`,
    );
  }
  return { company, questions };
}
