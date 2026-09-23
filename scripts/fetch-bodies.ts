/**
 * Fetch full question bodies for a company via the authenticated JSON API.
 * MCQ options/answers are fetched from a second endpoint for question_type=mcq.
 *
 *   node scripts/fetch-bodies.ts [--company=accenture] [--limit=N]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { ApiClient, RateLimited } from '../src/api.ts';
import { fromApiQuestion } from '../src/parse/apiQuestion.ts';

const arg = (k: string, d: string) =>
  process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d;
const slug = arg('company', 'accenture');
const limit = Number(arg('limit', '0'));
const dir = `data/slice_${slug}`;

const qs = JSON.parse(readFileSync(`${dir}/questions.json`, 'utf8')) as any[];
const targets = limit ? qs.slice(0, limit) : qs;

const api = new ApiClient();
const status = await api.premiumStatus();
console.log(`account premium=${status?.is_premium} plan=${status?.subscription?.subscription_type ?? '-'} expires=${(status?.subscription?.end_date ?? '').slice(0, 10)}`);
console.log(`fetching ${targets.length} questions for ${slug}\n`);

const rows = [];
let mcqCount = 0, optCount = 0, imgCount = 0, lockedCount = 0, failed = 0;
for (const [i, q] of targets.entries()) {
  try {
    const d = await api.getQuestion(q.source_id);
    if (!d) { failed++; continue; }
    const mcq = d.question_type === 'mcq' && q.numeric_id
      ? await api.getMcqItems(q.numeric_id)
      : { items: [], locked: false };
    // Only ask for images when the payload says there are some.
    const images = d.has_image ? await api.getImages(q.source_id) : [];
    const row = fromApiQuestion(d, mcq.items, images, mcq.locked);
    if (mcq.items.length) { mcqCount++; optCount += row.mcq_options.length; }
    if (mcq.locked) lockedCount++;
    imgCount += row.images.length;
    rows.push(row);
  } catch (e) {
    if (e instanceof RateLimited) {
      console.log(`\nRATE LIMITED after ${rows.length} questions this run.`);
      console.log(`  ${e.message}`);
      console.log(`  Retry in ${(e.retryAfterSec / 60).toFixed(0)} min. Progress is cached, so re-running resumes.`);
      break;
    }
    failed++;
    console.log(`  ! ${q.source_id}: ${String(e).slice(0, 90)}`);
  }
  if ((i + 1) % 25 === 0) console.log(`  ${i + 1}/${targets.length} ... requests=${api.requests}`);
}

writeFileSync(`${dir}/bodies_api.json`, JSON.stringify(rows, null, 2));

const withBody = rows.filter((r) => r.body_present);
const prem = rows.filter((r) => r.premium_required);
const premWithBody = prem.filter((r) => r.body_present);
console.log(`\n--- results ---`);
console.log(`fetched        : ${rows.length}/${targets.length} (failed ${failed})`);
console.log(`with statement : ${withBody.length}`);
console.log(`premium        : ${prem.length}, of which with statement: ${premWithBody.length}`);
console.log(`with editorial : ${rows.filter((r) => r.body.editorial).length}`);
console.log(`with code      : ${rows.filter((r) => r.code.length).length}`);
console.log(`with testcases : ${rows.filter((r) => r.body.input_test_case).length}`);
console.log(`mcq with options: ${mcqCount} (${optCount} options total)`);
console.log(`image refs    : ${imgCount} across ${rows.filter((r) => r.images.length).length} questions`);
console.log(`mock-OA locked : ${lockedCount} (statement kept, answer key withheld by the source)`);
console.log(`requests       : ${api.requests}`);

// The premium assertion: a gated row with no statement means the session died.
if (prem.length && premWithBody.length < prem.length) {
  console.log(`\nWARNING: ${prem.length - premWithBody.length} premium rows have NO statement -- session may have expired.`);
} else if (prem.length) {
  console.log(`\nOK: every premium row has a statement. Session was live throughout.`);
}
