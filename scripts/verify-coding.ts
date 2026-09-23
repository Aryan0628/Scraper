/** Validate the coding-question fields that Accenture's MCQ-heavy slice never exercised. */
import { readFileSync } from 'node:fs';

const rows = JSON.parse(readFileSync('data/slice_amazon/bodies_api.json', 'utf8')) as any[];
const coding = rows.filter((r) => r.qtype === 'coding');
console.log(`amazon: ${rows.length} total, ${coding.length} coding\n`);

const count = (pred: (r: any) => boolean) => coding.filter(pred).length;
const langs: Record<string, number> = {};
for (const r of coding) for (const c of r.code) langs[`${c.kind}:${c.lang}`] = (langs[`${c.kind}:${c.lang}`] ?? 0) + 1;

console.log('coding-question field coverage:');
console.log(`  statement_md            ${count((r) => r.body.problem_statement_md)}/${coding.length}`);
console.log(`  editorial               ${count((r) => r.body.editorial)}/${coding.length}`);
console.log(`  input_test_case         ${count((r) => r.body.input_test_case)}/${coding.length}`);
console.log(`  output_test_case        ${count((r) => r.body.output_test_case)}/${coding.length}`);
console.log(`  hidden_test_cases_ref   ${count((r) => r.body.hidden_test_cases_ref)}/${coding.length}`);
console.log(`  hidden_tc_blob_count    ${count((r) => r.body.hidden_test_cases_blob_count !== null)}/${coding.length}`);
console.log(`  any code                ${count((r) => r.code.length)}/${coding.length}`);
console.log(`  has_image               ${count((r) => r.has_image)}/${coding.length}`);
console.log(`  youtube_tutorial        ${count((r) => r.body.youtube_tutorial)}/${coding.length}`);
console.log(`  visual_animation        ${count((r) => r.body.visual_animation)}/${coding.length}`);

console.log('\ncode blocks by kind:lang:');
for (const [k, v] of Object.entries(langs).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(22)} ${v}`);

const biggest = coding.sort((a, b) => (b.body.problem_statement_md ?? '').length - (a.body.problem_statement_md ?? '').length)[0];
console.log(`\nlargest statement: ${biggest.title.slice(0, 56)}`);
console.log(`  md=${(biggest.body.problem_statement_md ?? '').length}ch editorial=${(biggest.body.editorial ?? '').length}ch`);
console.log(`  code: ${biggest.code.map((c: any) => `${c.lang}(${c.code.length})`).join(', ')}`);
console.log(`  tests: in=${(biggest.body.input_test_case ?? '').length}ch out=${(biggest.body.output_test_case ?? '').length}ch`);

// Catalog vs API disagreement noticed during the run.
const prem = rows.filter((r) => r.premium_required).length;
console.log(`\nNOTE: catalog declared premium=46, API rows report premium_required=1 on ${prem}.`);
