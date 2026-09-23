/** One request: a company's catalog shape, size and type mix. */
import { Fetcher } from '../src/fetcher.ts';
import { parseCompanyPage } from '../src/parse/company.ts';

const slug = process.argv.find((a) => a.startsWith('--company='))?.split('=')[1] ?? 'amazon';
const f = new Fetcher({ minIntervalMs: 700 });
const r = await f.get(`https://www.oahelper.in/company-questions/${slug}`, 'company');
try {
  const { company, questions } = parseCompanyPage(r.html);
  const mix: Record<string, number> = {};
  for (const q of questions) mix[q.qtype ?? 'null'] = (mix[q.qtype ?? 'null'] ?? 0) + 1;
  console.log(`${company.name}: declared=${company.question_count} parsed=${questions.length}  <-- inline, no pagination`);
  console.log(`  free=${company.free_question_count} premium=${company.premium_question_count}`);
  console.log(`  type mix: ${JSON.stringify(mix)}`);
  console.log(`  roles=${company.roles.length} colleges=${company.colleges.length}`);
} catch (e) {
  console.log(`PARSE FAILED (this is the signal we wanted): ${String(e).slice(0, 200)}`);
}
