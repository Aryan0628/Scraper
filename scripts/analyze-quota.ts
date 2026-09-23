/** What did we actually consume before the 429? Reads the local request manifest. */
import { readFileSync } from 'node:fs';

const rows = readFileSync('data/raw_pages.ndjson', 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l) as any)
  .filter((r) => r.authenticated === true);

if (!rows.length) {
  console.log('no authenticated requests recorded');
  process.exit(0);
}

rows.sort((a, b) => a.fetched_at.localeCompare(b.fetched_at));
const byKind: Record<string, number> = {};
for (const r of rows) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;

const first = new Date(rows[0].fetched_at);
const last = new Date(rows[rows.length - 1].fetched_at);
const mins = (last.getTime() - first.getTime()) / 60000;

console.log(`authenticated requests recorded: ${rows.length}`);
console.log(`  by kind: ${JSON.stringify(byKind)}`);
console.log(`  window : ${first.toISOString().slice(11, 19)} -> ${last.toISOString().slice(11, 19)} UTC (${mins.toFixed(1)} min)`);
console.log(`  rate   : ${(rows.length / Math.max(mins, 1)).toFixed(1)} req/min`);

// Only question views plausibly count toward a "content view" limit.
const views = rows.filter((r) => r.kind === 'q');
console.log(`\nquestion views (get_question): ${views.length}`);
const mcq = rows.filter((r) => r.kind === 'mcq');
console.log(`mcq-item calls               : ${mcq.length}`);

// Bucket question views per 10 minutes to see the shape of consumption.
console.log('\nquestion views per 10-min bucket:');
const buckets = new Map<string, number>();
for (const v of views) {
  const d = new Date(v.fetched_at);
  const k = `${String(d.getUTCHours()).padStart(2, '0')}:${String(Math.floor(d.getUTCMinutes() / 10) * 10).padStart(2, '0')}`;
  buckets.set(k, (buckets.get(k) ?? 0) + 1);
}
let cum = 0;
for (const [k, n] of [...buckets.entries()].sort()) {
  cum += n;
  console.log(`  ${k}  ${String(n).padStart(4)}   cumulative ${cum}`);
}
console.log(`\nNOTE: the 429 appeared after the last successful view above.`);
console.log(`The exact threshold and window are NOT directly observable -- the API`);
console.log(`returns no x-ratelimit-* headers, only Retry-After: 3600.`);
