/**
 * Post-login schema check. Fetches a few premium problems and diffs their raw
 * payload keys against a free one, so any field that only exists behind the
 * paywall (MCQ options being the open question) is found on 3 requests rather
 * than after 126.
 *
 *   node scripts/probe-premium.ts [--n=3]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { Fetcher } from '../src/fetcher.ts';
import { parsePage } from '../src/flight.ts';
import { parseProblemPage } from '../src/parse/problem.ts';

const n = Number(process.argv.find((a) => a.startsWith('--n='))?.split('=')[1] ?? '3');
const BASE = 'https://www.oahelper.in';
const f = new Fetcher({ minIntervalMs: 800, cache: false }); // always re-fetch: auth state matters
if (!f.authenticated) {
  console.error('No session found. Run: node scripts/login.ts');
  process.exit(1);
}

const qs = JSON.parse(readFileSync('data/slice_accenture/questions.json', 'utf8')) as any[];
const sitemap = JSON.parse(readFileSync('data/sitemap_urls.json', 'utf8')) as string[];
const urlFor = (id: string) => sitemap.find((u) => u.startsWith(`/problems/${id}/`));

// Baseline: the free question we already have, straight from its stored payload.
const freeKeys = new Set(
  Object.keys(
    (parsePage(
      (await import('node:zlib')).gunzipSync(
        readFileSync(
          'data/raw/' +
            (await import('node:fs')).readdirSync('data/raw').find((x) => x.startsWith('problem_'))!,
        ),
      ).toString('utf8'),
    ).get('initialQuestion') as object) ?? {},
  ),
);
console.log(`baseline free-question payload: ${freeKeys.size} keys\n`);

const premium = qs.filter((q) => q.premium_required).slice(0, n);
const rows = [];
for (const q of premium) {
  const path = urlFor(q.source_id);
  if (!path) continue;
  const r = await f.get(BASE + path, 'problem_auth');
  const p = parsePage(r.html);
  const obj = (p.get('initialQuestion') as Record<string, unknown>) ?? {};
  const row = parseProblemPage(r.html);
  const keys = Object.keys(obj);
  const novel = keys.filter((k) => !freeKeys.has(k));
  const missing = [...freeKeys].filter((k) => !keys.includes(k));

  console.log(`${q.source_id}  ${q.title.slice(0, 54)}`);
  console.log(`   type=${row.qtype} keys=${keys.length} body_present=${row.body_present}`);
  console.log(`   statement_md=${row.body.problem_statement_md?.length ?? 0} editorial=${row.body.editorial?.length ?? 0} code_blocks=${row.code.length}`);
  if (novel.length) console.log(`   NEW keys vs free: ${novel.join(', ')}`);
  if (missing.length) console.log(`   absent vs free: ${missing.join(', ')}`);

  // The open question: where do MCQ answer choices live?
  const optionish = Object.entries(obj).filter(([k]) =>
    /option|choice|answer|correct|alternativ/i.test(k),
  );
  console.log(
    optionish.length
      ? `   OPTION FIELDS FOUND: ${optionish.map(([k, v]) => `${k}=${JSON.stringify(v).slice(0, 90)}`).join(' | ')}`
      : `   no option/choice/answer field in payload`,
  );
  // Also scan the whole flight stream, in case options ride in another row.
  const hits = [...p.flight.matchAll(/"(option[a-z_]*|choices|correct_[a-z_]+|answer[a-z_]*)"/gi)];
  if (hits.length) console.log(`   flight-wide option-ish keys: ${[...new Set(hits.map((h) => h[1]))].join(', ')}`);
  console.log();
  rows.push({ source_id: q.source_id, keys, novel, missing, row });
}

writeFileSync('data/premium_probe.json', JSON.stringify(rows, null, 2));
console.log(`wrote data/premium_probe.json | requests=${f.requests}`);
