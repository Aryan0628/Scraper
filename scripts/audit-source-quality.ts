/** Evidence for the schema decisions: measure the source's own data problems. */
import { readFileSync } from 'node:fs';

const exps = JSON.parse(readFileSync('data/experiences_all.json', 'utf8')) as any[];
const bodies = ['accenture', 'amazon'].flatMap(
  (s) => JSON.parse(readFileSync(`data/slice_${s}/bodies_api.json`, 'utf8')) as any[],
);

console.log('=== 1. truncation in interview_experiences ===');
for (const field of ['difficulty_raw', 'result', 'rounds', 'topics_asked']) {
  const vals = exps.map((e) => e[field]).filter(Boolean) as string[];
  const lens = vals.map((v) => v.length);
  const atCap: Record<number, number> = {};
  for (const cap of [50, 100, 255]) atCap[cap] = lens.filter((l) => l === cap).length;
  const max = Math.max(...lens);
  console.log(`  ${field.padEnd(14)} n=${String(vals.length).padStart(5)} max=${String(max).padStart(5)}  exactly50=${atCap[50]} exactly100=${atCap[100]} exactly255=${atCap[255]}`);
  const cut = vals.filter((v) => v.length === 50).slice(0, 2);
  for (const c of cut) console.log(`      e.g. ${JSON.stringify(c)}`);
}

console.log('\n=== 2. difficulty vs difficulty_score: is one derivable? ===');
const pairs = new Map<string, Set<number>>();
for (const b of bodies) {
  if (!b.difficulty || b.difficulty_score === null) continue;
  if (!pairs.has(b.difficulty)) pairs.set(b.difficulty, new Set());
  pairs.get(b.difficulty)!.add(b.difficulty_score);
}
for (const [d, scores] of pairs) {
  const s = [...scores].sort((a, b) => a - b);
  console.log(`  ${d.padEnd(8)} scores ${s[0]}..${s[s.length - 1]}  (${s.length} distinct)`);
}

console.log('\n=== 3. code columns: how NULL is a column-per-language layout? ===');
const coding = bodies.filter((b) => b.qtype === 'coding');
const slots = 13;
const filled = coding.reduce((a, b) => a + b.code.length, 0);
console.log(`  coding questions=${coding.length}  slots=${coding.length * slots}  filled=${filled}  NULL=${(100 * (1 - filled / (coding.length * slots))).toFixed(0)}%`);

console.log('\n=== 4. MCQ options as option_1..option_4 (repeating group) ===');
const mcq = bodies.filter((b) => b.qtype === 'mcq');
const optCounts: Record<number, number> = {};
for (const m of mcq) {
  const n = m.mcq_options.length;
  optCounts[n] = (optCounts[n] ?? 0) + 1;
}
console.log(`  options per MCQ: ${JSON.stringify(optCounts)}`);
console.log(`  -> a fixed option_1..option_4 layout cannot store 5+, and wastes a column at 3.`);

console.log('\n=== 5. company name chaos across experiences ===');
const raw = new Set(exps.map((e) => e.company_name_raw.toLowerCase().trim()));
const keyed = exps.filter((e) => e.practice_company_key).length;
console.log(`  distinct raw names=${raw.size}  with company key=${keyed}/${exps.length} (${(100 * keyed / exps.length).toFixed(0)}%)`);
const flip = [...raw].filter((r) => r.includes('flipkart'));
console.log(`  "flipkart" variants: ${flip.slice(0, 8).map((f) => JSON.stringify(f)).join(', ')}`);
