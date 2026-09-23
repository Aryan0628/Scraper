/** Render ONE premium page with the saved session and record how the body arrives. */
import { chromium } from 'playwright-core';
import { readFileSync, writeFileSync } from 'node:fs';

const BASE = 'https://www.oahelper.in';
const qs = JSON.parse(readFileSync('data/slice_accenture/questions.json', 'utf8')) as any[];
const sm = JSON.parse(readFileSync('data/sitemap_urls.json', 'utf8')) as string[];
const q = qs.find((x) => x.premium_required)!;
const path = sm.find((u) => u.startsWith(`/problems/${q.source_id}/`))!;

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await browser.newContext({ storageState: '.secrets/storageState.json' });
const page = await ctx.newPage();

const calls: { method: string; url: string; status?: number; body?: string }[] = [];
page.on('response', async (r) => {
  const u = r.url();
  if (u.includes('/rest/v1/') || u.includes('/api/') || u.includes('supabase.co')) {
    let body = '';
    try { body = (await r.text()).slice(0, 700); } catch { /* opaque */ }
    calls.push({ method: r.request().method(), url: u, status: r.status(), body });
  }
});

await page.goto(BASE + path, { waitUntil: 'networkidle' });
await page.waitForTimeout(3000);

const text = await page.locator('body').innerText();
console.log(`page: ${q.title.slice(0, 60)}`);
console.log(`rendered text length: ${text.length}`);
console.log(`statement visible?  ${/which of the following|what is|choose|following/i.test(text)}`);
console.log(`paywall visible?    ${/upgrade|unlock|go premium|subscribe/i.test(text)}`);

console.log(`\n=== option UI in DOM ===`);
for (const sel of ['input[type=radio]', '[class*=option]', '[class*=choice]', 'label']) {
  console.log(`  ${sel}: ${await page.locator(sel).count()}`);
}
const letters = (text.match(/^\s*[A-D][).:]\s/gm) || []).length;
console.log(`  A)/B)/C)/D) markers in visible text: ${letters}`);

console.log(`\n=== data-bearing calls (${calls.length}) ===`);
for (const c of calls) {
  console.log(`  ${c.method} ${c.status} ${c.url.slice(0, 160)}`);
  if (c.body && c.body.length > 20) console.log(`     -> ${c.body.replace(/\s+/g, ' ').slice(0, 260)}`);
}
writeFileSync('data/transport_probe.json', JSON.stringify({ calls, textSample: text.slice(0, 2000) }, null, 2));
console.log('\nwrote data/transport_probe.json');
await browser.close();
