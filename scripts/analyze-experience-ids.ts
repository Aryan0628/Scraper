/** Which experience ids are we missing, and are they fetchable directly? */
import { readFileSync } from 'node:fs';

const all = JSON.parse(readFileSync('data/experiences_all.json', 'utf8')) as any[];
const ids = all.map((e) => e.source_numeric_id).sort((a, b) => a - b);
const have = new Set(ids);

console.log(`held: ${ids.length} | id range: ${ids[0]} .. ${ids[ids.length - 1]}`);
const span = ids[ids.length - 1] - ids[0] + 1;
const missing: number[] = [];
for (let i = ids[0]; i <= ids[ids.length - 1]; i++) if (!have.has(i)) missing.push(i);
console.log(`id span: ${span} | missing ids in range: ${missing.length}`);

// Contiguous runs tell deleted-block from scattered-skip.
const runs: [number, number][] = [];
let start: number | null = null;
let prev = 0;
for (const m of missing) {
  if (start === null) { start = prev = m; continue; }
  if (m === prev + 1) { prev = m; continue; }
  runs.push([start, prev]);
  start = prev = m;
}
if (start !== null) runs.push([start, prev]);
console.log(`missing runs: ${runs.length}`);
console.log(`longest runs: ${runs.sort((a, b) => (b[1] - b[0]) - (a[1] - a[0])).slice(0, 5).map(([a, b]) => `${a}-${b}(${b - a + 1})`).join(', ')}`);

console.log(`\nSitemap lists 2,633 experience URLs; we hold ${all.length}.`);
console.log(`Missing ids are directly fetchable at /interview-experience/<base64(id)>`);
console.log(`-- that route is plain HTML, NOT the rate-limited /api/proxy/question endpoint.`);
