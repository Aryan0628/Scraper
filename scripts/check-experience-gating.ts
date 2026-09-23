/**
 * Were the 2,618 experiences we crawled anonymously complete, or is some content
 * gated? Re-fetch a few index pages WITH the premium session and diff.
 */
import { readFileSync } from 'node:fs';
import { Fetcher } from '../src/fetcher.ts';
import { parseExperienceIndex } from '../src/parse/experience.ts';

const cached = JSON.parse(readFileSync('data/experiences_all.json', 'utf8')) as any[];
const byId = new Map(cached.map((e) => [e.source_numeric_id, e]));
console.log(`anonymous crawl: ${cached.length} experiences\n`);

// cache:false so we genuinely re-request as an authenticated user.
const f = new Fetcher({ minIntervalMs: 800, cache: false });
console.log(`session present: ${f.authenticated}\n`);

let declaredTotal = 0;
let compared = 0;
let longer = 0;
let shorter = 0;
let newIds = 0;
const diffs: string[] = [];

for (const page of [1, 2, 3, 50, 120]) {
  const r = await f.get(`https://www.oahelper.in/interview-experiences?page=${page}`, 'exp_auth');
  const { experiences, total } = parseExperienceIndex(r.html);
  if (total) declaredTotal = total;
  for (const e of experiences) {
    const old = byId.get(e.source_numeric_id);
    if (!old) {
      newIds++;
      continue;
    }
    compared++;
    const a = (old.experience_html ?? '').length;
    const b = (e.experience_html ?? '').length;
    if (b > a) {
      longer++;
      diffs.push(`id=${e.source_numeric_id} anon=${a} auth=${b} (+${b - a})`);
    } else if (b < a) {
      shorter++;
    }
  }
  console.log(`page ${String(page).padStart(3)}: ${experiences.length} items, declared total=${total}`);
}

console.log(`\ncompared ${compared} experiences seen in both crawls`);
console.log(`  narrative LONGER when logged in : ${longer}`);
console.log(`  narrative shorter               : ${shorter}`);
console.log(`  ids not present in anon crawl   : ${newIds}`);
if (diffs.length) {
  console.log('\n  examples of gated content:');
  for (const d of diffs.slice(0, 8)) console.log('    ' + d);
}
console.log(`\ndeclared total now: ${declaredTotal} | we hold: ${cached.length} | gap: ${declaredTotal - cached.length}`);
