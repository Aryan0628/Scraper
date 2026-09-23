/**
 * Import a session you captured yourself, with no automated browser involved.
 *
 * You log in to oahelper.in in your ordinary Chrome (Google OAuth works there),
 * run the snippet printed by `--snippet` in DevTools, and save what it prints to
 * .secrets/session-paste.json. This converts it into the storageState format the
 * crawler already reads.
 *
 *   node scripts/import-session.ts --snippet     # print the DevTools snippet
 *   node scripts/import-session.ts               # convert the pasted file
 */
import { readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { parseProblemPage } from '../src/parse/problem.ts';

const PASTE = '.secrets/session-paste.json';
const STATE = '.secrets/storageState.json';
const BASE = 'https://www.oahelper.in';

if (process.argv.includes('--snippet')) {
  console.log(`
Run this in DevTools Console on https://www.oahelper.in while logged in
(Cmd+Opt+J), then copy the whole output into ${PASTE}:

------------------------------------------------------------------
copy(JSON.stringify({
  cookie: document.cookie,
  localStorage: Object.fromEntries(Object.entries(localStorage)),
  origin: location.origin
}))
------------------------------------------------------------------

'copy(...)' puts it straight on your clipboard. Then:
  pbpaste > ${PASTE}
  node scripts/import-session.ts
`);
  process.exit(0);
}

if (!existsSync(PASTE)) {
  console.error(`${PASTE} not found. Run: node scripts/import-session.ts --snippet`);
  process.exit(1);
}

const paste = JSON.parse(readFileSync(PASTE, 'utf8')) as {
  cookie: string;
  localStorage: Record<string, string>;
  origin?: string;
};

const cookies = (paste.cookie ?? '')
  .split(';')
  .map((c) => c.trim())
  .filter(Boolean)
  .map((c) => {
    const i = c.indexOf('=');
    return {
      name: c.slice(0, i),
      value: c.slice(i + 1),
      domain: '.oahelper.in',
      path: '/',
      expires: -1,
      httpOnly: false,
      secure: true,
      sameSite: 'Lax' as const,
    };
  });

const state = {
  cookies,
  origins: [
    {
      origin: paste.origin ?? BASE,
      localStorage: Object.entries(paste.localStorage ?? {}).map(([name, value]) => ({
        name,
        value,
      })),
    },
  ],
};

writeFileSync(STATE, JSON.stringify(state, null, 2));
chmodSync(STATE, 0o600);

const sb = Object.keys(paste.localStorage ?? {}).filter((k) => k.startsWith('sb-'));
console.log(`wrote ${STATE} (chmod 600)`);
console.log(`  cookies: ${cookies.length} -> ${cookies.map((c) => c.name).slice(0, 8).join(', ')}`);
console.log(`  localStorage keys: ${Object.keys(paste.localStorage ?? {}).length}`);
console.log(`  supabase auth keys: ${sb.length ? sb.join(', ') : 'NONE (may be a problem)'}`);

// Verify against a real premium question.
const qs = JSON.parse(readFileSync('data/slice_accenture/questions.json', 'utf8')) as any[];
const sitemap = JSON.parse(readFileSync('data/sitemap_urls.json', 'utf8')) as string[];
const probe = qs.find((q) => q.premium_required)!;
const path = sitemap.find((u) => u.startsWith(`/problems/${probe.source_id}/`))!;

const res = await fetch(BASE + path, {
  headers: {
    Cookie: cookies.map((c) => `${c.name}=${c.value}`).join('; '),
  },
});
const html = await res.text();
let ok = false;
let len = 0;
try {
  const row = parseProblemPage(html);
  ok = row.body_present;
  len = row.body.problem_statement_md?.length ?? 0;
} catch { /* ignore */ }

console.log(`\nverify premium ${probe.source_id}: HTTP ${res.status} body_present=${ok} statement=${len} chars`);
console.log(
  ok
    ? '  => session works. Next: node scripts/probe-premium.ts'
    : '  => still gated. The gate likely needs an HttpOnly cookie that DevTools\n' +
      '     cannot read, or the body is fetched client-side from Supabase.',
);
