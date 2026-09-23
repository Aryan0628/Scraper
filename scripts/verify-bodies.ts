/** Quality checks on a fetched body set. Read-only, local files. */
import { readFileSync } from 'node:fs';

const slug = process.argv.find((a) => a.startsWith('--company='))?.split('=')[1] ?? 'accenture';
const rows = JSON.parse(readFileSync(`data/slice_${slug}/bodies_api.json`, 'utf8')) as any[];

const mcq = rows.filter((x) => x.qtype === 'mcq');
console.log(
  `total=${rows.length} mcq=${mcq.length} coding=${rows.filter((x) => x.qtype === 'coding').length} sql=${rows.filter((x) => x.qtype === 'sql').length}`,
);

const noOpts = mcq.filter((x) => !x.mcq_options.length);
console.log(`MCQs with ZERO options: ${noOpts.length}${noOpts.length ? ' -> ' + noOpts.slice(0, 5).map((x) => x.source_id).join(', ') : ''}`);

const noCorrect = mcq.filter((x) => x.mcq_options.length && !x.mcq_options.some((o: any) => o.is_correct));
console.log(`MCQs with options but NO correct answer marked: ${noCorrect.length}`);

const multi = mcq.filter((x) => new Set(x.mcq_options.map((o: any) => o.mcq_index)).size > 1);
console.log(`MCQs holding multiple sub-questions: ${multi.length}`);

const dist: Record<number, number> = {};
for (const x of mcq) {
  const n = x.mcq_options.filter((o: any) => o.mcq_index === 1).length;
  dist[n] = (dist[n] ?? 0) + 1;
}
console.log(`options-per-question: ${JSON.stringify(dist)}`);

const sample = mcq.find((x) => x.mcq_options.length);
if (sample) {
  console.log(`\nSAMPLE: ${sample.title.slice(0, 64)}`);
  console.log(`  statement_md=${(sample.body.problem_statement_md ?? '').length}ch editorial=${(sample.body.editorial ?? '').length}ch`);
  for (const o of sample.mcq_options.slice(0, 4)) {
    console.log(`   ${o.label}${o.is_correct ? ' [CORRECT]' : '         '} ${o.body.slice(0, 76).replace(/\s+/g, ' ')}`);
  }
}

const chars = rows.reduce(
  (a, x) => a + (x.body.problem_statement_md ?? '').length + (x.body.editorial ?? '').length,
  0,
);
const optChars = rows.reduce(
  (a, x) => a + x.mcq_options.reduce((b: number, o: any) => b + o.body.length, 0),
  0,
);
console.log(`\ntext captured: ${(chars / 1024).toFixed(0)}KB statements+editorials, ${(optChars / 1024).toFixed(0)}KB options`);
