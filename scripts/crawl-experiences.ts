/**
 * Crawl every /interview-experiences?page=N. The index embeds 12 FULL records
 * each, narrative included, so ~220 requests replaces 2,633 detail fetches.
 */
import { writeFileSync } from 'node:fs';
import { Fetcher } from '../src/fetcher.ts';
import { parseExperienceIndex } from '../src/parse/experience.ts';

const f = new Fetcher({ minIntervalMs: 600 });
const all = new Map<number, ReturnType<typeof parseExperienceIndex>['experiences'][number]>();
let total = 0;
for (let page = 1; page <= 250; page++) {
  const r = await f.get(`https://www.oahelper.in/interview-experiences?page=${page}`, 'exp_index');
  const { experiences, total: t } = parseExperienceIndex(r.html);
  if (t) total = t;
  if (!experiences.length) {
    console.log(`page ${page}: empty, stopping`);
    break;
  }
  for (const e of experiences) all.set(e.source_numeric_id, e);
  if (page % 20 === 0) console.log(`page ${page}: unique=${all.size}/${total}`);
  if (all.size >= total && total > 0) {
    console.log(`page ${page}: reached declared total`);
    break;
  }
}
writeFileSync('data/experiences_all.json', JSON.stringify([...all.values()], null, 2));
console.log(`\ndone: ${all.size} unique of ${total} declared | requests=${f.requests}`);
const byCompany = new Map<string, number>();
for (const e of all.values()) {
  const k = (e.practice_company_key ?? e.company_name_raw).toLowerCase();
  byCompany.set(k, (byCompany.get(k) ?? 0) + 1);
}
console.log(`distinct companies: ${byCompany.size}`);
console.log('top 15:', [...byCompany.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, v]) => `${k}:${v}`).join(' '));
