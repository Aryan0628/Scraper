import { readFileSync } from 'node:fs';
import { parsePage, decodeId } from '../src/flight.ts';

const cases: [string, string[]][] = [
  ['fixtures/acc.html', ['initialCompany', 'initialQuestions']],
  ['fixtures/p_free.html', ['initialQuestion']],
  ['fixtures/p_prem.html', ['initialQuestion']],
  ['fixtures/ie.html', ['initialExperience']],
  ['fixtures/ci.html', ['ai_summary', 'topic_frequency']],
  ['fixtures/mock.html', ['initialAssessments']],
  ['fixtures/cal.html', ['initialRange']],
  ['fixtures/probidx.html', ['initialQuestions', 'initialTotalCount']],
];

for (const [file, keys] of cases) {
  const html = readFileSync(file, 'utf8');
  const p = parsePage(html);
  console.log(`\n${file}  flight=${p.flight.length.toLocaleString()}B rows=${p.rows.size}`);
  for (const k of keys) {
    const v = p.get(k);
    let desc: string;
    if (Array.isArray(v)) desc = `array[${v.length}]`;
    else if (v && typeof v === 'object') desc = `object{${Object.keys(v).length} keys}`;
    else if (typeof v === 'string') desc = `string(${v.length})`;
    else desc = String(v);
    console.log(`   ${k}: ${desc}`);
  }
}

// The two fields that arrive as $refs -- must be resolved text, not "$1e"/"$22".
const ie = parsePage(readFileSync('fixtures/ie.html', 'utf8'));
const exp = (ie.get('initialExperience') as Record<string, unknown>) ?? {};
const narrative = exp.experience as string;
console.log('\n--- $ref resolution ---');
console.log('experience  :', typeof narrative, `len=${narrative?.length}`, JSON.stringify(String(narrative).slice(0, 80)));

const pf = parsePage(readFileSync('fixtures/p_free.html', 'utf8'));
const q = (pf.get('initialQuestion') as Record<string, unknown>) ?? {};
const ed = q.editorial as string;
console.log('editorial   :', typeof ed, `len=${ed?.length}`, JSON.stringify(String(ed).slice(0, 80)));
console.log('statement_md:', `len=${String(q.md_problem_statement).length}`);
console.log('lc_tags     :', typeof q.lc_tags, JSON.stringify(q.lc_tags).slice(0, 90));
console.log('decodeId    :', q.id, '->', decodeId(String(q.id)));
