/**
 * One-company vertical slice: pull every URL family that applies to a single
 * company, so the schema can be validated end-to-end before any bulk crawl.
 *
 *   node scripts/slice.ts [--company=accenture] [--exp-pages=20] [--premium]
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { Fetcher } from '../src/fetcher.ts';
import { discover } from '../src/discover.ts';
import { parseCompanyPage } from '../src/parse/company.ts';
import { parseProblemPage } from '../src/parse/problem.ts';
import { parseExperienceIndex } from '../src/parse/experience.ts';

const arg = (k: string, d: string) =>
  process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d;
const slug = arg('company', 'accenture');
const expPages = Number(arg('exp-pages', '20'));
const wantPremium = process.argv.includes('--premium');
const BASE = 'https://www.oahelper.in';
const OUT = `data/slice_${slug}`;
mkdirSync(OUT, { recursive: true });

const f = new Fetcher({ minIntervalMs: 700 });
console.log(`slice: ${slug} | authenticated=${f.authenticated}\n`);

const idx = await discover(f);
console.log(`sitemap: ${idx.all.length} urls | ${idx.companies.length} companies | ${idx.problems.length} problems | ${idx.experiences.length} experiences\n`);

// 1. Company catalog -------------------------------------------------------
const cp = await f.get(`${BASE}/company-questions/${slug}`, 'company');
const { company, questions } = parseCompanyPage(cp.html);
console.log(`[1] ${company.name}: ${questions.length} questions (declared ${company.question_count})`);
console.log(`    free=${company.free_question_count} premium=${company.premium_question_count}`);
console.log(`    roles=${company.roles.length} colleges=${company.colleges.length} types=${company.question_types.join('/')}`);

// 2. Question bodies -------------------------------------------------------
const free = questions.filter((q) => !q.premium_required);
const premium = questions.filter((q) => q.premium_required);
const targets = wantPremium ? questions : free;
console.log(`\n[2] bodies: fetching ${targets.length} (${free.length} free, ${premium.length} premium${wantPremium ? ', premium included' : ', premium skipped'})`);

const bodies = [];
let missingUrl = 0;
let gated = 0;
for (const q of targets) {
  const path = idx.problemUrlById.get(q.source_id);
  if (!path) {
    missingUrl++;
    continue;
  }
  const r = await f.get(BASE + path, 'problem');
  const row = parseProblemPage(r.html);
  if (!row.body_present) gated++;
  bodies.push(row);
}
const withBody = bodies.filter((b) => b.body_present);
console.log(`    parsed=${bodies.length} with_body=${withBody.length} gated=${gated} no_sitemap_url=${missingUrl}`);
console.log(`    with code solutions: ${bodies.filter((b) => b.code.length > 0).length}`);
console.log(`    with editorial: ${bodies.filter((b) => b.body.editorial).length}`);

// 3. Interview experiences (index carries full records, 12/page) -----------
// Prefer the full cached crawl when present: ~209 requests covers all 2,633,
// and company filtering is client-side only (?company= does not work).
const mine = [];
if (existsSync('data/experiences_all.json')) {
  const all = JSON.parse(readFileSync('data/experiences_all.json', 'utf8')) as any[];
  const needle = slug.toLowerCase();
  mine.push(
    ...all.filter(
      (e) =>
        e.practice_company_key?.toLowerCase() === needle ||
        e.company_name_raw.toLowerCase().includes(needle),
    ),
  );
  console.log(`\n[3] experiences: ${all.length} cached | matched ${slug}: ${mine.length}`);
} else {
  console.log(`\n[3] experiences: scanning ${expPages} index pages (run crawl-experiences.ts for all)`);
  let scanned = 0;
  let total = 0;
  for (let page = 1; page <= expPages; page++) {
    const r = await f.get(`${BASE}/interview-experiences?page=${page}`, 'exp_index');
    const { experiences, total: t } = parseExperienceIndex(r.html);
    if (t) total = t;
    if (!experiences.length) break;
    scanned += experiences.length;
    const needle = slug.toLowerCase();
    mine.push(
      ...experiences.filter(
        (e) =>
          e.practice_company_key?.toLowerCase() === needle ||
          e.company_name_raw.toLowerCase().includes(needle),
      ),
    );
  }
  console.log(`    scanned=${scanned} of ${total} | matched ${slug}: ${mine.length}`);
}
if (mine.length) {
  const withN = mine.filter((e: any) => e.experience_html).length;
  console.log(`    with narrative: ${withN}/${mine.length} | roles: ${[...new Set(mine.map((e: any) => e.role))].slice(0, 4).join(', ')}`);
}

// 4. Write ------------------------------------------------------------------
writeFileSync(`${OUT}/company.json`, JSON.stringify(company, null, 2));
writeFileSync(`${OUT}/questions.json`, JSON.stringify(questions, null, 2));
writeFileSync(`${OUT}/bodies.json`, JSON.stringify(bodies, null, 2));
writeFileSync(`${OUT}/experiences.json`, JSON.stringify(mine, null, 2));
console.log(`\nwrote ${OUT}/ | http requests made: ${f.requests}`);
