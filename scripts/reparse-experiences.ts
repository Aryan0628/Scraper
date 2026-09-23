/**
 * Rebuild experiences_all.json from stored snapshots, with no network calls.
 *
 * The first parser discarded oacoins_awarded, proof_blob_path, reviewed_at,
 * automated_review_id and the raw interview_date. Because every page was
 * gzipped to disk before parsing, those fields are recoverable by re-parsing --
 * which is the entire reason for the snapshot-first rule.
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { parseExperienceIndex, parseExperiencePage } from '../src/parse/experience.ts';

const files = readdirSync('data/raw').filter((f) => f.startsWith('exp_index_') || f.startsWith('experience_'));
console.log(`re-parsing ${files.length} snapshots (0 network requests)`);

const byId = new Map<number, any>();
let failed = 0;
for (const f of files) {
  const html = gunzipSync(readFileSync(`data/raw/${f}`)).toString('utf8');
  try {
    if (f.startsWith('exp_index_')) {
      for (const e of parseExperienceIndex(html).experiences) byId.set(e.source_numeric_id, e);
    } else {
      const e = parseExperiencePage(html);
      byId.set(e.source_numeric_id, e);
    }
  } catch {
    failed++;
  }
}

const rows = [...byId.values()].sort((a, b) => a.source_numeric_id - b.source_numeric_id);
const prev = JSON.parse(readFileSync('data/experiences_all.json', 'utf8')) as any[];
writeFileSync('data/experiences_all.json', JSON.stringify(rows, null, 2));

const filled = (f: string) => rows.filter((r) => r[f] !== null && r[f] !== undefined).length;
console.log(`\nparsed ${rows.length} (was ${prev.length}), ${failed} snapshots unreadable`);
console.log('recovered fields:');
for (const f of ['oacoins_awarded', 'proof_blob_path', 'reviewed_at', 'automated_review_id', 'interview_date_raw'])
  console.log(`  ${f.padEnd(22)} ${filled(f)} rows populated`);
console.log(`  ${'source_payload'.padEnd(22)} ${rows.filter((r) => r.source_payload).length} rows`);

// Now that the raw date is back, how many are genuinely ambiguous?
const amb = rows.filter((r) => r.interview_date_raw && /^\d{2}-\d{2}-\d{4}$/.test(r.interview_date_raw))
  .filter((r) => Number(r.interview_date_raw.slice(0, 2)) <= 12);
console.log(`\ndates needing DD-MM vs MM-DD disambiguation: ${amb.length}`);
if (amb.length) console.log(`  e.g. ${amb.slice(0, 5).map((r) => r.interview_date_raw).join(', ')}`);
