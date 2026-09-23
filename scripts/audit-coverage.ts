/** Which tables would actually hold rows today, given the data on disk? */
import { readFileSync, existsSync } from 'node:fs';

const read = (p: string) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);
const companies = ['accenture', 'amazon']
  .map((s) => read(`data/slice_${s}/company.json`))
  .filter(Boolean);
const questions = ['accenture', 'amazon'].flatMap((s) => read(`data/slice_${s}/questions.json`) ?? []);
const bodies = ['accenture', 'amazon'].flatMap((s) => read(`data/slice_${s}/bodies_api.json`) ?? []);
const exps = read('data/experiences_all.json') ?? [];

const n = (x: number) => String(x).padStart(6);
console.log('POPULATED TODAY');
console.log(`  core.companies            ${n(companies.length)}  (455 available)`);
console.log(`  core.questions            ${n(questions.length)}`);
console.log(`  core.question_bodies      ${n(bodies.filter((b: any) => b.body_present).length)}`);
console.log(`  core.question_code        ${n(bodies.reduce((a: number, b: any) => a + b.code.length, 0))}`);
console.log(`  core.question_mcq_items   ${n(bodies.reduce((a: number, b: any) => a + b.mcq_items.length, 0))}`);
console.log(`  core.question_options     ${n(bodies.reduce((a: number, b: any) => a + b.mcq_options.length, 0))}`);
console.log(`  core.topics               ${n(new Set(questions.flatMap((q: any) => q.tags)).size)}  distinct`);
console.log(`  core.question_topics      ${n(questions.reduce((a: number, q: any) => a + q.tags.length, 0))}`);
console.log(`  core.company_questions    ${n(questions.length)}`);
console.log(`  core.interview_experiences${n(exps.length)}`);
console.log(`  core.roles                ${n(new Set([...companies.flatMap((c: any) => c.roles), ...bodies.map((b: any) => b.role).filter(Boolean)]).size)}  distinct`);
console.log(`  core.colleges             ${n(new Set(companies.flatMap((c: any) => c.colleges)).size)}  distinct`);
console.log(`  core.company_aliases      ${n(new Set(exps.map((e: any) => e.company_name_raw.toLowerCase())).size)}  distinct raw names`);

console.log('\nEMPTY -- no data scraped for these');
console.log('  core.assessments / assessment_sections / assessment_questions  (mock OA never parsed)');
console.log('  core.oa_calendar          (gated; hidden_count only)');
console.log('  core.company_insights     (only 3 companies server-rendered)');
console.log('  core.question_metrics     (times_seen/last_asked live in insights)');
console.log('  core.experience_questions (has_questions flag exists; links never scraped)');
console.log('  ingest.crawl_queue        (scripts resume from the file cache, not a DB queue)');
console.log('  ingest.question_revisions (needs a second crawl to diff against)');
console.log('  ALL of schema app         (no users, no product -- entirely inferred)');
