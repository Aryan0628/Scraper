/**
 * Close the gap left by offset-pagination drift: diff what we hold against the
 * sitemap's experience URLs and fetch exactly the missing ones by id.
 *
 * These are plain HTML pages, not the rate-limited /api/proxy/question endpoint.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { Fetcher } from '../src/fetcher.ts';
import { parseExperiencePage } from '../src/parse/experience.ts';
import { decodeId } from '../src/flight.ts';

const all = JSON.parse(readFileSync('data/experiences_all.json', 'utf8')) as any[];
const have = new Set(all.map((e) => e.source_numeric_id));
const sitemap = JSON.parse(readFileSync('data/sitemap_urls.json', 'utf8')) as string[];

const listed = sitemap
  .filter((u) => /^\/interview-experience\/[^/]+$/.test(u))
  .map((u) => ({ url: u, id: decodeId(u.split('/')[2]) }))
  .filter((x) => x.id !== null) as { url: string; id: number }[];

const missing = listed.filter((x) => !have.has(x.id));
console.log(`sitemap lists ${listed.length} experiences | we hold ${have.size} | missing ${missing.length}`);
if (!missing.length) {
  console.log('nothing to fetch -- dataset already covers every sitemap-listed experience.');
  process.exit(0);
}
console.log(`ids: ${missing.map((m) => m.id).slice(0, 30).join(', ')}${missing.length > 30 ? ' ...' : ''}\n`);

const f = new Fetcher({ minIntervalMs: 700 });
const added = [];
let failed = 0;
for (const m of missing) {
  try {
    const r = await f.get('https://www.oahelper.in' + m.url, 'experience');
    added.push(parseExperiencePage(r.html));
  } catch (e) {
    failed++;
    console.log(`  ! ${m.id}: ${String(e).slice(0, 80)}`);
  }
}

const merged = [...all];
const seen = new Set(all.map((e) => e.source_numeric_id));
for (const e of added) if (!seen.has(e.source_numeric_id)) { merged.push(e); seen.add(e.source_numeric_id); }
merged.sort((a, b) => a.source_numeric_id - b.source_numeric_id);
writeFileSync('data/experiences_all.json', JSON.stringify(merged, null, 2));

console.log(`\nfetched ${added.length}, failed ${failed}`);
console.log(`total experiences now: ${merged.length} (was ${all.length})`);
console.log(`with narrative: ${merged.filter((e) => e.experience_html).length}/${merged.length}`);
console.log(`requests: ${f.requests}`);
