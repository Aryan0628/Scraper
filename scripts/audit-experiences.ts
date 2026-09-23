/** What is actually wrong with the interview_experiences data. */
import { readFileSync } from 'node:fs';
const e = JSON.parse(readFileSync('data/experiences_all.json', 'utf8')) as any[];

console.log(`n = ${e.length}\n`);

console.log('=== result: should be a small closed set ===');
const results = new Map<string, number>();
for (const x of e) results.set(x.result ?? '(null)', (results.get(x.result ?? '(null)') ?? 0) + 1);
console.log(`  distinct values: ${results.size}`);
for (const [k, v] of [...results.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6))
  console.log(`    ${String(v).padStart(4)}  ${JSON.stringify(k.slice(0, 60))}`);

console.log('\n=== machine-inferred content? ===');
for (const marker of ['Implied by', 'presumably', 'Based on similar', 'likely', 'Not Specified']) {
  const n = e.filter((x) => JSON.stringify(x).includes(marker)).length;
  if (n) console.log(`    "${marker}": ${n} rows`);
}

console.log('\n=== interview_date: format consistency ===');
const fmt: Record<string, number> = {};
for (const x of e) {
  const d = x.interview_date;
  if (!d) { fmt['(null)'] = (fmt['(null)'] ?? 0) + 1; continue; }
  const k = /^\d{4}-\d{2}-\d{2}$/.test(d) ? 'YYYY-MM-DD' : /^\d{2}-\d{2}-\d{4}$/.test(d) ? 'DD-MM-YYYY?' : 'other';
  fmt[k] = (fmt[k] ?? 0) + 1;
}
console.log(`    ${JSON.stringify(fmt)}`);
const future = e.filter((x) => x.interview_date && x.interview_date > '2026-09-22').length;
console.log(`    dated in the future: ${future}`);

console.log('\n=== rounds: a count, or prose? ===');
const numeric = e.filter((x) => x.rounds && /^\d+$/.test(x.rounds.trim())).length;
const prose = e.filter((x) => x.rounds && !/^\d+$/.test(x.rounds.trim())).length;
console.log(`    pure number: ${numeric}   prose: ${prose}`);

console.log('\n=== topics_asked: joinable to core.topics? ===');
const withTopics = e.filter((x) => x.topics_asked);
const commaish = withTopics.filter((x) => x.topics_asked.includes(',')).length;
const lens = withTopics.map((x) => x.topics_asked.length);
console.log(`    populated: ${withTopics.length}/${e.length}, contain a comma: ${commaish}`);
console.log(`    length: min=${Math.min(...lens)} max=${Math.max(...lens)} avg=${Math.round(lens.reduce((a, b) => a + b, 0) / lens.length)}`);
const split = new Set(withTopics.flatMap((x) => x.topics_asked.split(/[,;]/).map((s: string) => s.trim().toLowerCase())));
console.log(`    distinct comma-split fragments: ${split.size}  <-- free text, not a vocabulary`);

console.log('\n=== duplicate submissions? ===');
const seen = new Map<string, number>();
for (const x of e) {
  const k = `${(x.company_name_raw ?? '').toLowerCase()}|${(x.body_html ?? '').slice(0, 200)}`;
  seen.set(k, (seen.get(k) ?? 0) + 1);
}
console.log(`    identical (company + first 200 chars of body): ${[...seen.values()].filter((v) => v > 1).length} groups`);

console.log('\n=== status / moderation ===');
const st = new Map<string, number>();
for (const x of e) st.set(x.status ?? '(null)', (st.get(x.status ?? '(null)') ?? 0) + 1);
console.log(`    ${JSON.stringify(Object.fromEntries(st))}`);
