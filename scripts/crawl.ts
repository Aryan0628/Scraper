/**
 * Resumable crawl orchestrator. One entry point, two modes:
 *
 *   node --env-file=.env scripts/crawl.ts backfill   # catalogs, then drain all bodies
 *   node --env-file=.env scripts/crawl.ts daily       # re-catalog, fetch only new bodies
 *
 * Resumability is by construction, not bookkeeping:
 *   - the worklist is a SQL query (body_fetched_at IS NULL), so a restart just
 *     continues; already-done rows are invisible to it.
 *   - upserts key on source_id, so re-fetching a row updates, never duplicates.
 *   - snapshots are cached on disk, so a re-fetch of the same URL skips the net.
 *
 * Rate: get_question is the only call that counts against the 150/hour cap, so
 * it is paced at ~26s (≈138/hour) to stay under it and never trip 429. If a 429
 * happens anyway (e.g. the session was also used interactively), it sleeps
 * Retry-After and resumes -- no work is lost.
 *
 * Every meaningful step logs a timestamped line to stdout, which GCP Cloud Run /
 * Cloud Logging captures verbatim, so progress is visible without shell access.
 */
import { readFileSync, existsSync } from 'node:fs';
import postgres from 'postgres';
import { Fetcher } from '../src/fetcher.ts';
import { ApiClient, RateLimited } from '../src/api.ts';
import { parseCompanyPage } from '../src/parse/company.ts';
import { parseExperienceIndex } from '../src/parse/experience.ts';
import { fromApiQuestion } from '../src/parse/apiQuestion.ts';
import { upsertCompany, upsertCatalog, upsertQuestionFromApi, upsertExperience } from '../src/upsert.ts';

const BASE = 'https://www.oahelper.in';
// backfill/daily = catalogs then bodies then experiences; catalog = catalogs
// only (free, uncapped); bodies = drain the body worklist only (spends quota);
// experiences = re-index interview experiences only (uncapped, cheap).
const MODES = ['backfill', 'daily', 'catalog', 'bodies', 'experiences'] as const;
const mode = (process.argv[2] ?? 'backfill') as (typeof MODES)[number];
if (!MODES.includes(mode)) {
  console.error(`unknown mode "${mode}"; use ${MODES.join(' | ')}`);
  process.exit(2);
}
const doCatalogs = mode === 'backfill' || mode === 'daily' || mode === 'catalog';
const doBodies = mode === 'backfill' || mode === 'daily' || mode === 'bodies';
const doExperiences = mode === 'backfill' || mode === 'daily' || mode === 'experiences';

// ~26s between views ≈ 138/hour, safely under the 150/hour cap. Override with
// VIEW_INTERVAL_MS for testing.
const VIEW_INTERVAL_MS = Number(process.env.VIEW_INTERVAL_MS ?? 26_000);
const BATCH = 100; // worklist page size; re-queried each pass so it self-heals

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is not set'); process.exit(1); }
const sql = postgres(url, { onnotice: () => {}, max: 4, idle_timeout: 20, prepare: false });

const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Graceful shutdown: Cloud Run sends SIGTERM before killing. Finish the current
// question (already awaited), mark the run interrupted, exit clean.
let stopping = false;
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => { log(`${sig} received -- stopping after current item`); stopping = true; });
}

// Local cache only (absent in the container). refreshSitemapAndSlugs replaces
// it with the live sitemap, which is what phase 1.5 must seed from.
let sitemap: string[] = existsSync('data/sitemap_urls.json')
  ? JSON.parse(readFileSync('data/sitemap_urls.json', 'utf8'))
  : [];
const slugById = new Map<string, string>();
for (const u of sitemap) {
  const m = /^\/problems\/([^/]+)\/(.+)$/.exec(u);
  if (m) slugById.set(m[1], m[2]);
}

/** Company slugs from the sitemap (the authoritative list is the site, not us). */
async function refreshSitemapAndSlugs(f: Fetcher): Promise<string[]> {
  const res = await f.get(`${BASE}/sitemap.xml`, 'sitemap');
  const urls = [...res.html.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) =>
    m[1].replace('https://www.oahelper.in', ''),
  );
  sitemap = urls;
  for (const u of urls) {
    const m = /^\/problems\/([^/]+)\/(.+)$/.exec(u);
    if (m) slugById.set(m[1], m[2]);
  }
  return urls.filter((u) => /^\/company-questions\/[^/]+$/.test(u)).map((u) => u.split('/')[2]);
}

// ---------------------------------------------------------------- phase 1
async function crawlCatalogs(runId: number): Promise<number> {
  const f = new Fetcher({ minIntervalMs: 800 }); // catalogs are uncapped; be polite
  const slugs = await refreshSitemapAndSlugs(f);
  log(`phase 1: ${slugs.length} company catalogs`);

  let done = 0;
  for (const slug of slugs) {
    if (stopping) break;
    try {
      const res = await f.get(`${BASE}/company-questions/${slug}`, 'company');
      const { company, questions } = parseCompanyPage(res.html);
      const cid = await upsertCompany(sql, company);
      await upsertCatalog(sql, cid, questions, slugById);
      await sql`
        INSERT INTO ingest.company_crawl (slug, catalog_status, catalog_at, question_count, attempts, updated_at)
        VALUES (${slug}, 'done', now(), ${questions.length}, 1, now())
        ON CONFLICT (slug) DO UPDATE SET
          catalog_status = 'done', catalog_at = now(),
          question_count = ${questions.length},
          attempts = ingest.company_crawl.attempts + 1,
          last_error = NULL, updated_at = now()`;
      done++;
      if (done % 25 === 0) log(`  catalogs: ${done}/${slugs.length}`);
    } catch (e) {
      const msg = String(e).slice(0, 200);
      log(`  ! catalog ${slug}: ${msg}`);
      await sql`
        INSERT INTO ingest.company_crawl (slug, catalog_status, attempts, last_error, updated_at)
        VALUES (${slug}, 'failed', 1, ${msg}, now())
        ON CONFLICT (slug) DO UPDATE SET
          catalog_status = 'failed',
          attempts = ingest.company_crawl.attempts + 1,
          last_error = ${msg}, updated_at = now()`;
    }
  }
  await sql`UPDATE ingest.crawl_runs SET companies_seen = ${done} WHERE id = ${runId}`;
  log(`phase 1 done: ${done} catalogs`);
  return done;
}

// ------------------------------------------------- phase 1.5: seed sitemap IDs
/**
 * Register every sitemap /problems/ id as a bare pending question, so the body
 * worklist covers the ~5,124 questions that no company page lists. get_question
 * fills their metadata when the body crawl reaches them (upsertQuestionFromApi).
 * Free: no fetching, just IDs we already have. Existing rows are untouched.
 */
async function seedSitemapProblems(): Promise<number> {
  const decode = (tok: string): number | null => {
    try {
      const d = Buffer.from(tok + '='.repeat((4 - (tok.length % 4)) % 4), 'base64').toString('utf8');
      const n = parseInt(d.split('|')[0], 10);
      return Number.isFinite(n) ? n : null;
    } catch {
      return null;
    }
  };
  const rows = [
    ...new Map(
      sitemap
        .filter((u) => /^\/problems\/[^/]+\//.test(u))
        .map((u) => u.split('/')[2])
        .map((tok) => [tok, { source_id: tok, source_numeric_id: decode(tok), title: tok, title_norm: tok, slug: tok, is_premium: false }]),
    ).values(),
  ];
  // 0 here means the sitemap never loaded, not "nothing new" -- a silent 0 once
  // left ~5k uncatalogued questions out of the worklist on every container run.
  if (!rows.length) {
    log('  WARNING: phase 1.5 found no /problems/ URLs in the sitemap -- worklist is incomplete');
    return 0;
  }
  let seeded = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    // DO NOTHING: never overwrite a real catalogued row with a placeholder.
    const out = await sql`INSERT INTO core.questions ${sql(chunk)}
      ON CONFLICT (source_id) DO NOTHING RETURNING id`;
    seeded += out.length;
  }
  log(`phase 1.5: seeded ${seeded} new sitemap questions (worklist now complete)`);
  return seeded;
}

// ---------------------------------------------------------------- phase 2
class SessionDead extends Error {}

/**
 * Account status behind OA_SESSION (uncapped, not a content view). A dead cookie
 * may answer 401/403 rather than is_premium=false; both mean "session dead".
 * Network errors still throw, so a blip is never mistaken for a dead session.
 */
async function accountStatus(api: ApiClient): Promise<any> {
  try {
    return await api.premiumStatus();
  } catch (e) {
    if (/HTTP 40[13]/.test(String(e))) return null;
    throw e;
  }
}
const sessionAlive = async (api: ApiClient) => (await accountStatus(api))?.is_premium === true;

/** Returns 'complete' | 'interrupted' | 'session_dead'. */
async function drainBodies(runId: number): Promise<string> {
  // readCache=false: never replay a snapshot that may have been taken while the
  // session was dead -- that would save an empty body as done.
  const api = new ApiClient('.secrets/storageState.json', VIEW_INTERVAL_MS, 400, false);
  const status = await accountStatus(api);
  log(`phase 2: session premium=${status?.is_premium} plan=${status?.subscription?.subscription_type ?? '-'} expires=${(status?.subscription?.end_date ?? '-').slice(0, 10)}`);
  if (status?.is_premium !== true) {
    log('  SESSION DEAD: account is not premium (expired login or subscription). Refresh OA_SESSION and restart the job. No bodies fetched.');
    return 'session_dead';
  }

  const [{ n: pending }] = await sql`SELECT count(*)::int n FROM core.questions WHERE body_fetched_at IS NULL AND deleted_at IS NULL`;
  log(`  worklist: ${pending} questions owe a body (paced ~${(VIEW_INTERVAL_MS / 1000).toFixed(0)}s each => ~${(pending * VIEW_INTERVAL_MS / 3.6e6).toFixed(1)}h)`);

  let fetched = 0;
  let mismatches = 0;
  const flush = () => sql`UPDATE ingest.crawl_runs SET bodies_fetched = ${fetched} WHERE id = ${runId}`;
  while (!stopping) {
    // Re-query each pass: self-healing (picks up new rows, skips done ones).
    // is_premium on a pending row is still the company page's flag (the API
    // value replaces it on save), and `catalogued` tells a real company-page flag
    // apart from a sitemap-seeded placeholder.
    const work: any[] = await sql`
      SELECT q.id, q.source_id, q.source_numeric_id, q.kind, q.is_premium AS catalog_premium,
             EXISTS (SELECT 1 FROM core.company_questions cq WHERE cq.question_id = q.id) AS catalogued
      FROM core.questions q
      WHERE q.body_fetched_at IS NULL AND q.deleted_at IS NULL
      ORDER BY q.is_premium DESC, q.id
      LIMIT ${BATCH}`;
    if (!work.length) {
      log(`phase 2 done: worklist empty (${mismatches} premium-rule mismatches this run)`);
      return 'complete';
    }

    for (const q of work) {
      if (stopping) return 'interrupted';
      try {
        const d = await api.getQuestion(q.source_id);
        if (!d) { log(`  ! ${q.source_id}: no data returned`); continue; }
        const mcq = d.question_type === 'mcq' && q.source_numeric_id
          ? await api.getMcqItems(q.source_numeric_id)
          : { items: [], locked: false };
        const images = d.has_image ? await api.getImages(q.source_id) : [];
        const row = fromApiQuestion(d, mcq.items, images, mcq.locked);

        // An empty statement is either a genuinely empty question or a dead
        // session. Ask the account, not the question's flags: premium_required
        // misses mock-OA questions and sitemap-only rows have no company flag.
        if (!row.body_present && !(await sessionAlive(api))) {
          throw new SessionDead(`${q.source_id} returned no statement and the account is no longer premium`);
        }

        // The company page's lock appears to be premium_required OR is_mock_oa
        // (verified on Cisco only). Log disagreements so the backfill tests it.
        if (q.catalogued && q.catalog_premium !== (row.premium_required || row.is_mock_oa)) {
          mismatches++;
          log(`  premium-rule mismatch: ${q.source_id} company=${q.catalog_premium} api=${row.premium_required} mock_oa=${row.is_mock_oa}`);
        }

        // Fills catalog fields + company + topics + body, so it completes both
        // pre-catalogued rows and bare sitemap-seeded rows.
        await upsertQuestionFromApi(sql, row);
        fetched++;
        if (fetched % 20 === 0) {
          log(`  bodies: +${fetched} this run (views=${api.views})`);
          await flush();
        }
      } catch (e) {
        if (e instanceof RateLimited) {
          const wait = (e.retryAfterSec + 30) * 1000;
          log(`  rate limited (${fetched} fetched this run). sleeping ${(wait / 60000).toFixed(0)}min, then resuming.`);
          await flush();
          // Sleep in short slices so SIGTERM stays responsive; log every 5 min
          // so the job's logs show it is waiting, not hung.
          for (let slept = 0; slept < wait && !stopping; slept += 5000) {
            await sleep(5000);
            if (slept > 0 && slept % 300_000 === 0) log(`  rate limited: resuming in ~${((wait - slept) / 60000).toFixed(0)}min`);
          }
          break; // re-query the worklist and continue
        }
        if (e instanceof SessionDead) {
          log(`  SESSION DEAD: ${e.message}. Refresh OA_SESSION and restart the job. Stopping.`);
          await flush();
          return 'session_dead';
        }
        // A refused fetch may be the session dying rather than this question.
        if (/HTTP 40[13]/.test(String(e)) && !(await sessionAlive(api))) {
          log(`  SESSION DEAD: ${q.source_id} refused (${String(e).slice(0, 60)}) and the account is no longer premium. Refresh OA_SESSION and restart the job. Stopping.`);
          await flush();
          return 'session_dead';
        }
        log(`  ! ${q.source_id}: ${String(e).slice(0, 160)}`); // transient; leave pending, retry next pass
      }
    }
  }
  return 'interrupted';
}

// ---------------------------------------------------------------- phase 3
/**
 * Page through /interview-experiences?page=N and upsert every record. The index
 * embeds 12 FULL records per page (narrative included), so ~220 requests cover
 * the whole corpus -- ~18x cheaper than fetching each detail page.
 *
 * Uncapped: this does NOT touch /api/proxy/question, so it does not spend the
 * 150/hour content-view quota. Paced at ~600ms just to be polite. Stops when a
 * page returns empty, or when we've collected the declared total. Duplicates
 * across pages are natural (new experiences push older ones down) and are
 * dropped by source_numeric_id before writing.
 */
async function crawlExperiences(runId: number): Promise<number> {
  const f = new Fetcher({ minIntervalMs: 600 });
  const seen = new Set<number>();
  let total = 0;
  let upserted = 0;
  for (let page = 1; page <= 250 && !stopping; page++) {
    try {
      const r = await f.get(`${BASE}/interview-experiences?page=${page}`, 'exp_index');
      const { experiences, total: t } = parseExperienceIndex(r.html);
      if (t) total = t;
      if (!experiences.length) { log(`  experiences page ${page}: empty, stopping`); break; }
      for (const e of experiences) {
        if (stopping) break;
        if (seen.has(e.source_numeric_id)) continue;
        seen.add(e.source_numeric_id);
        try {
          await upsertExperience(sql, e);
          upserted++;
        } catch (err) {
          log(`  ! experience ${e.source_numeric_id}: ${String(err).slice(0, 160)}`);
        }
      }
      if (page % 20 === 0) log(`  experiences: page ${page}, upserted=${upserted}/${total || '?'}`);
      if (total > 0 && seen.size >= total) { log(`  experiences: reached declared total (${total})`); break; }
    } catch (e) {
      log(`  ! experiences page ${page}: ${String(e).slice(0, 160)}`);
      // transient; try next page rather than aborting the whole phase
    }
  }
  await sql`UPDATE ingest.crawl_runs SET experiences_seen = ${upserted} WHERE id = ${runId}`;
  log(`phase 3 done: ${upserted} experiences upserted`);
  return upserted;
}

// ---------------------------------------------------------------- main
const [{ id: runId }] = await sql`
  INSERT INTO ingest.crawl_runs (mode) VALUES (${mode}) RETURNING id`;
log(`run ${runId} start: mode=${mode}`);

let reason = 'complete';
try {
  if (doCatalogs && !stopping) {
    await crawlCatalogs(runId);
    if (!stopping) await seedSitemapProblems(); // complete the worklist
  }
  if (doBodies && !stopping) reason = await drainBodies(runId);
  // Experiences need no login, so they run even when the session is dead; the
  // run still exits 1 afterwards so the dead session is not missed.
  if (doExperiences && !stopping) await crawlExperiences(runId);
  if (stopping && reason === 'complete') reason = 'interrupted';
} catch (e) {
  reason = 'error';
  log(`FATAL: ${String(e).slice(0, 300)}`);
} finally {
  await sql`UPDATE ingest.crawl_runs SET finished_at = now(), stopped_reason = ${reason} WHERE id = ${runId}`;
  const [{ q, b }] = await sql`
    SELECT (SELECT count(*)::int FROM core.questions) q,
           (SELECT count(*)::int FROM core.questions WHERE body_fetched_at IS NOT NULL) b`;
  log(`run ${runId} end: ${reason}. db has ${q} questions, ${b} with bodies (${q - b} pending).`);
  await sql.end({ timeout: 5 });
  process.exit(reason === 'error' || reason === 'session_dead' ? 1 : 0);
}
