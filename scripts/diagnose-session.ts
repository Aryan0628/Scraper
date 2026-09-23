import { readFileSync } from 'node:fs';
import { parsePage } from '../src/flight.ts';
import { parseProblemPage } from '../src/parse/problem.ts';

const st = JSON.parse(readFileSync('.secrets/storageState.json', 'utf8'));
const BASE = 'https://www.oahelper.in';
const cookieHeader = st.cookies.filter((c: any) => c.domain.includes('oahelper.in'))
  .map((c: any) => `${c.name}=${c.value}`).join('; ');

console.log('cookie NAMES:', st.cookies.map((c: any) => c.name).join(', '));
console.log('localStorage KEYS:', (st.origins?.[0]?.localStorage ?? []).map((i: any) => i.name).join(', '));

const get = async (path: string, withCookies = true) => {
  const r = await fetch(BASE + path, {
    headers: withCookies
      ? { Cookie: cookieHeader }
      : {},
  });
  return { status: r.status, html: await r.text() };
};

const qs = JSON.parse(readFileSync('data/slice_accenture/questions.json', 'utf8')) as any[];
const sm = JSON.parse(readFileSync('data/sitemap_urls.json', 'utf8')) as string[];
const url = (id: string) => sm.find((u) => u.startsWith(`/problems/${id}/`))!;
const freeQ = qs.find((q) => !q.premium_required)!;
const premQ = qs.find((q) => q.premium_required)!;

console.log('\n=== 1. does the session register as logged in? ===');
const home = await get('/');
for (const marker of ['Sign in', 'Login', 'Logout', 'Sign out', 'Dashboard', 'My Profile', 'Upgrade', 'Go Premium']) {
  const n = (home.html.match(new RegExp(marker, 'gi')) || []).length;
  if (n) console.log(`  "${marker}": ${n}`);
}

console.log('\n=== 2. FREE question WITH cookies (control) ===');
const f1 = await get(url(freeQ.source_id));
const fr = parseProblemPage(f1.html);
console.log(`  HTTP ${f1.status} body_present=${fr.body_present} md=${fr.body.problem_statement_md?.length ?? 0}`);

console.log('\n=== 3. PREMIUM question WITH cookies ===');
const p1 = await get(url(premQ.source_id));
const pr = parseProblemPage(p1.html);
const obj = parsePage(p1.html).get('initialQuestion') as Record<string, unknown>;
console.log(`  HTTP ${p1.status} body_present=${pr.body_present} keys=${Object.keys(obj ?? {}).length}`);
console.log(`  keys: ${Object.keys(obj ?? {}).join(', ')}`);

console.log('\n=== 4. premium/paywall markers on that page ===');
for (const m of ['Upgrade', 'Unlock', 'premium_required', 'Subscribe', 'Buy Premium', 'This is a premium', 'Get Premium', 'locked']) {
  const n = (p1.html.match(new RegExp(m, 'gi')) || []).length;
  if (n) console.log(`  "${m}": ${n}`);
}

console.log('\n=== 5. account/subscription state ===');
const prem = await get('/premium');
for (const m of ['Your plan', 'Active', 'Expires', 'You are subscribed', 'Upgrade Now', 'Choose a plan', 'Current Plan']) {
  const n = (prem.html.match(new RegExp(m, 'gi')) || []).length;
  if (n) console.log(`  "${m}": ${n}`);
}
