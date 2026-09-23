/**
 * Capture a logged-in session, once, by hand.
 *
 * Opens your real Chrome. YOU type the credentials -- this script never reads,
 * transmits or stores them. It saves only the resulting session to
 * .secrets/storageState.json (gitignored, chmod 600).
 *
 * Deliberately non-intrusive: it NEVER opens tabs or navigates while you are
 * logging in (doing so stole focus and made the window jitter). It only reads
 * cookies/localStorage in place, saves the moment a session appears, and does
 * all verification over plain HTTP afterwards.
 *
 *   node scripts/login.ts [--minutes=15]
 */
import { chromium } from 'playwright-core';
import { writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { parseProblemPage } from '../src/parse/problem.ts';

const STATE = '.secrets/storageState.json';
const BASE = 'https://www.oahelper.in';
const minutes = Number(process.argv.find((a) => a.startsWith('--minutes='))?.split('=')[1] ?? '15');

const qs = JSON.parse(readFileSync('data/slice_accenture/questions.json', 'utf8')) as {
  source_id: string; premium_required: boolean; title: string;
}[];
const PROBE = qs.find((q) => q.premium_required)!;
const sitemap = JSON.parse(readFileSync('data/sitemap_urls.json', 'utf8')) as string[];
const probePath = sitemap.find((u) => u.startsWith(`/problems/${PROBE.source_id}/`))!;

const browser = await chromium.launch({ channel: 'chrome', headless: false });
const ctx = await browser.newContext({ viewport: { width: 1340, height: 920 } });
const page = await ctx.newPage();
await page.goto(BASE, { waitUntil: 'domcontentloaded' });

console.log(`
============================================================
  Sign in to oahelper.in in the Chrome window.

  Take your time. I will NOT touch the window, open tabs, or
  navigate -- no more jittering. Log in normally.

  Your password is never read or stored; only the session.
  Saving automatically the moment it appears. Up to ${minutes} min.
============================================================
`);

let saved = false;
const save = async (why: string) => {
  const state = await ctx.storageState();
  writeFileSync(STATE, JSON.stringify(state, null, 2));
  chmodSync(STATE, 0o600);
  saved = true;
  const lsKeys = (state.origins ?? []).flatMap((o) => o.localStorage.map((i) => i.name));
  console.log(`\nSESSION SAVED -> ${STATE}  (${why})`);
  console.log(`  cookies=${state.cookies.length} localStorage=${lsKeys.length}`);
  const sb = lsKeys.filter((k) => k.startsWith('sb-'));
  console.log(`  supabase auth keys: ${sb.length ? sb.join(', ') : 'none'}`);
  return state;
};

// If the window is closed, save whatever we have rather than crashing.
let closed = false;
ctx.on('close', () => { closed = true; });
page.on('close', () => { closed = true; });

const deadline = Date.now() + minutes * 60_000;
let state: Awaited<ReturnType<typeof ctx.storageState>> | null = null;

while (Date.now() < deadline && !closed) {
  await new Promise((r) => setTimeout(r, 4000));
  try {
    const cookies = await ctx.cookies();
    const authCookies = cookies.filter(
      (c) => c.domain.includes('oahelper.in') && /sb-|auth|session|token/i.test(c.name),
    );
    // Read localStorage in place -- no new page, no navigation.
    let lsAuth: string[] = [];
    if (page.url().includes('oahelper.in')) {
      lsAuth = await page.evaluate(() =>
        Object.keys(localStorage).filter((k) => k.startsWith('sb-')),
      );
    }
    if (authCookies.length || lsAuth.length) {
      state = await save(`auth detected: ${[...authCookies.map((c) => c.name), ...lsAuth].slice(0, 3).join(', ')}`);
      break;
    }
  } catch {
    // Page navigating (e.g. OAuth redirect) -- just retry next tick.
  }
}

if (!saved) {
  if (closed) console.log('\nWindow was closed before a session appeared. Nothing saved -- re-run to retry.');
  else console.log('\nTimed out with no session detected. Nothing saved -- re-run to retry.');
  try { await browser.close(); } catch {}
  process.exit(1);
}

// ---- Verification happens over plain HTTP, so the window is left alone. ----
console.log(`\nverifying premium access via plain fetch (no browser interaction)...`);
const cookieHeader = state!.cookies
  .filter((c) => c.domain.includes('oahelper.in'))
  .map((c) => `${c.name}=${c.value}`)
  .join('; ');
const res = await fetch(BASE + probePath, {
  headers: { Cookie: cookieHeader },
});
const html = await res.text();
let ok = false;
let mdLen = 0;
try {
  const row = parseProblemPage(html);
  ok = row.body_present;
  mdLen = row.body.problem_statement_md?.length ?? 0;
} catch { /* ignore */ }

console.log(`  ${PROBE.source_id} -> HTTP ${res.status} body_present=${ok} statement_md=${mdLen} chars`);
console.log(
  ok
    ? '\n  => cookie-only crawling WORKS. Next: node scripts/probe-premium.ts'
    : '\n  => cookies alone are NOT enough (body still gated). The body is likely\n' +
      '     fetched client-side from Supabase, which needs either a rendering\n' +
      '     crawl or the access token -- the latter needs Next Wave sign-off.',
);
console.log('\nYou can close the Chrome window now; the session is already saved.');
try { await browser.close(); } catch {}
