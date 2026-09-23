/** Shared coercions for the site's inconsistent field shapes. */

/** lc_tags arrives as a real array on list pages, a JSON string on detail pages. */
export function toTags(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((t) => String(t).trim()).filter(Boolean);
  if (typeof v === 'string' && v.trim()) {
    try {
      const parsed = JSON.parse(v);
      if (Array.isArray(parsed)) return parsed.map((t) => String(t).trim()).filter(Boolean);
    } catch {
      return v.split(',').map((t) => t.trim()).filter(Boolean);
    }
  }
  return [];
}

export function toBool(v: unknown): boolean {
  return v === 1 || v === true || v === '1' || v === 'true';
}

export function toInt(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

const DIFFS = new Set(['easy', 'medium', 'hard']);

/**
 * Detail pages give a `difficulty` string; list pages give only a score.
 *
 * Do NOT infer the label from the score. Measured over 185 questions the bands
 * OVERLAP badly -- easy 15..42, medium 38..66, hard 62..70 -- so a score of 40
 * is genuinely ambiguous between easy and medium, and 65 between medium and
 * hard. An earlier version bucketed <40/<70/else and silently produced wrong
 * labels for every list-only row. Return null instead and let the score stand
 * on its own; the label is only trustworthy when the source states it.
 */
export function toDifficulty(v: unknown): 'easy' | 'medium' | 'hard' | null {
  const s = String(v ?? '').toLowerCase().trim();
  return DIFFS.has(s) ? (s as 'easy' | 'medium' | 'hard') : null;
}

/** "16 Sep 2026" | "2025-01-13" | "09-08-2026" -> ISO date, or null. */
/**
 * Return an ISO date ONLY when the input is unambiguously one. Never invent
 * precision the source did not have.
 *
 * The source's user-entered dates are free text -- "October 2024", "2023",
 * "Around November 2024". An earlier version ran Date.parse on these, which
 * fabricated a specific day (and, via UTC rollback, often the wrong month) for
 * 1,508 rows. That was wrong: a month is not a day, a year is not a date. Such
 * values now return null, and the raw string is preserved separately
 * (interview_date_raw) so the original is never lost.
 *
 * Accepts: ISO `YYYY-MM-DD`, and DD-MM-YYYY where the day is > 12 (so it cannot
 * be a month, i.e. unambiguous). A DD-MM-YYYY with day <= 12 is genuinely
 * ambiguous (09-08 = 9 Aug or 8 Sep?) and returns null rather than a guess.
 */
export function toDate(v: unknown): string | null {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const dmy = /^(\d{2})-(\d{2})-(\d{4})$/.exec(s);
  if (dmy) {
    const day = Number(dmy[1]);
    const month = Number(dmy[2]);
    if (month >= 1 && month <= 12 && day > 12 && day <= 31) {
      return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
    }
    return null; // ambiguous or invalid -- keep only the raw string
  }
  return null; // prose ("October 2024", "2023", ...) is not a date
}

export function toText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v);
  // A leftover "$1e" means a flight ref was never resolved -- treat as missing
  // rather than storing the pointer as content.
  if (/^\$[0-9a-f]{1,8}$/.test(s)) return null;
  return s.length ? s : null;
}

export function normTitle(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
