import { parsePage } from '../flight.ts';
import { toInt, toDate, toText } from '../normalize.ts';

export type ExperienceRow = {
  source_numeric_id: number;
  company_name_raw: string;
  practice_company_key: string | null;
  practice_company_ref: string | null;
  role: string | null;
  college: string | null;
  interview_date: string | null;
  interview_type: string | null;
  result: string | null;
  difficulty_raw: string | null;
  rounds: string | null;
  topics_asked: string | null;
  experience_html: string | null;
  status: string | null;
  helpful_count: number | null;
  has_questions: boolean;
  oacoins_awarded: number | null;
  proof_blob_path: string | null;
  reviewed_at: string | null;
  automated_review_id: string | null;
  source_created_at: string | null;
  source_updated_at: string | null;
  interview_date_raw: string | null;
  source_payload: Record<string, unknown>;
};

function toRow(e: Record<string, unknown>): ExperienceRow {
  return {
    source_numeric_id: Number(e.id),
    company_name_raw: String(e.company ?? '').trim(),
    practice_company_key: toText(e.practice_company_key),
    practice_company_ref: toText(e.practice_company_ref),
    role: toText(e.role),
    college: toText(e.college),
    interview_date: toDate(e.interview_date),
    interview_type: toText(e.interview_type),
    result: toText(e.result),
    difficulty_raw: toText(e.difficulty),
    rounds: toText(e.rounds),
    topics_asked: toText(e.topics_asked),
    experience_html: toText(e.experience),
    status: toText(e.status),
    helpful_count: toInt(e.helpful_count),
    has_questions: e.has_questions === true,
    oacoins_awarded: toInt(e.oacoins_awarded),
    proof_blob_path: toText(e.proof_blob_path),
    reviewed_at: e.reviewed_at ? String(e.reviewed_at) : null,
    automated_review_id: toText(e.automated_review_id),
    source_created_at: e.created_at ? String(e.created_at) : null,
    source_updated_at: e.updated_at ? String(e.updated_at) : null,
    // toDate() normalises in place and the source uses two formats, one of
    // which ("09-08-2026") is ambiguous for any day <= 12. Keep the original so
    // the ambiguity stays visible instead of becoming a confident wrong date.
    interview_date_raw: e.interview_date ? String(e.interview_date) : null,
    source_payload: e,
  };
}

/** Parse /interview-experience/<id> (one full record). */
export function parseExperiencePage(html: string): ExperienceRow {
  const p = parsePage(html);
  const e = p.get('initialExperience') as Record<string, unknown> | undefined;
  if (!e) throw new Error('initialExperience missing -- page shape changed');
  return toRow(e);
}

/**
 * Parse /interview-experiences?page=N. The index embeds 12 FULL records
 * including the narrative, so it is ~18x cheaper than fetching each detail page.
 */
export function parseExperienceIndex(html: string) {
  const p = parsePage(html);
  const list = (p.get('initialExperiences') as Record<string, unknown>[] | undefined) ?? [];
  return {
    total: toInt(p.get('initialTotalCount')),
    experiences: list.map(toRow),
  };
}
