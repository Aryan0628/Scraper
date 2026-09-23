/**
 * Authenticated JSON client for oahelper.in's own /api/proxy/* endpoints -- the
 * same ones the site's frontend calls. Discovered by inspecting the logged-in
 * page in a browser, as Next Wave directed.
 *
 * Far cheaper than HTML: ~2KB of JSON per question vs ~33KB of markup, and no
 * flight-payload parsing. Premium bodies are ONLY available this way; the server
 * does not render them into the page.
 *
 * Note: reading editorials through get_question does NOT consume the account's
 * 15/day quota -- that quota is for *requesting* new solutions to be authored.
 */
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { appendFileSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';

const BASE = 'https://www.oahelper.in';

/** Thrown when the account's content-view quota is exhausted. Not retryable. */
export class RateLimited extends Error {
  // Explicit fields, not parameter properties: Node's type-stripping only
  // supports erasable syntax, so `constructor(public x)` fails at runtime.
  retryAfterSec: number;
  body: string;
  constructor(retryAfterSec: number, body: string) {
    super(`rate limited: retry after ${retryAfterSec}s -- ${body.slice(0, 120)}`);
    this.name = 'RateLimited';
    this.retryAfterSec = retryAfterSec;
    this.body = body;
  }
}

/**
 * Load the logged-in session from either a local file or the OA_SESSION env var
 * (raw JSON or base64), so GCP can inject it from Secret Manager without a file.
 */
function loadCookieHeader(statePath: string): string {
  let raw: string | undefined;
  const env = process.env.OA_SESSION;
  if (env) {
    raw = env.trim().startsWith('{') ? env : Buffer.from(env, 'base64').toString('utf8');
  } else if (existsSync(statePath)) {
    raw = readFileSync(statePath, 'utf8');
  }
  if (!raw) throw new Error(`no session: set OA_SESSION env or ${statePath} (run scripts/login.ts)`);
  const st = JSON.parse(raw) as { cookies: any[] };
  const header = st.cookies
    .filter((c) => c.domain.includes('oahelper.in'))
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  if (!header) throw new Error('session has no oahelper.in cookies -- re-run scripts/login.ts');
  return header;
}

export class ApiClient {
  private cookie: string;
  // Two separate pacers: `view` throttles get_question (the only call that
  // counts against the 150/hour content-view cap, so it paces at ~26s to stay
  // under it), `aux` throttles mcq/image calls (uncapped, just politeness).
  private lastView = 0;
  private lastAux = 0;
  private viewInterval: number;
  private auxInterval: number;
  private dir = 'data/api';
  public requests = 0;
  public views = 0;

  constructor(statePath = '.secrets/storageState.json', viewIntervalMs = 600, auxIntervalMs = 400) {
    this.cookie = loadCookieHeader(statePath);
    this.viewInterval = viewIntervalMs;
    this.auxInterval = auxIntervalMs;
    mkdirSync(this.dir, { recursive: true });
  }

  private async pace(kind: 'view' | 'aux') {
    const [last, interval] =
      kind === 'view' ? [this.lastView, this.viewInterval] : [this.lastAux, this.auxInterval];
    const wait = interval - (Date.now() - last);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait + Math.random() * 250));
    if (kind === 'view') this.lastView = Date.now();
    else this.lastAux = Date.now();
  }

  private async throttle() {
    await this.pace('aux');
  }

  /**
   * @param tolerate HTTP statuses to return rather than throw on. Used for
   *   expected refusals -- e.g. 403 mock_oa_answer_locked, where the server
   *   withholds a mock test's answer key until the attempt is submitted. That
   *   is a product rule, not a failure, and it must not discard the statement
   *   we already spent quota fetching.
   */
  private async json(
    path: string,
    kind: string,
    cache = true,
    tolerate: number[] = [],
    paceKind: 'view' | 'aux' = 'aux',
  ): Promise<any> {
    const key = createHash('sha256').update(path).digest('hex').slice(0, 16);
    const file = `${this.dir}/${kind}_${key}.json.gz`;
    if (cache && existsSync(file)) {
      const { gunzipSync } = await import('node:zlib');
      return JSON.parse(gunzipSync(readFileSync(file)).toString('utf8'));
    }
    for (let attempt = 1; attempt <= 4; attempt++) {
      await this.pace(paceKind);
      this.requests++;
      if (paceKind === 'view') this.views++;
      let res: Response;
      let text: string;
      try {
        // Node's fetch has NO default timeout: a hung socket otherwise blocks the
        // entire run forever, which is exactly what happened on the first attempt.
        res = await fetch(BASE + path, {
          headers: { Cookie: this.cookie, Accept: 'application/json' },
          signal: AbortSignal.timeout(25_000),
        });
        if (res.status === 429) {
          // "Content view limit reached" -- a deliberate fair-use cap on the
          // account, with Retry-After in seconds (observed: 3600). Retrying is
          // pointless and just hammers their API, so abort the whole run and let
          // the caller decide. Never storm a 429.
          const retryAfter = Number(res.headers.get('retry-after') ?? 3600);
          throw new RateLimited(retryAfter, await res.text());
        }
        if (res.status >= 500) {
          await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
          continue;
        }
        text = await res.text();
      } catch (e) {
        if (e instanceof RateLimited) throw e;
        if (attempt === 4) throw new Error(`timeout/network after 4 attempts: ${path}`);
        await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
        continue;
      }
      // Snapshot before parsing, same rule as the HTML crawler.
      writeFileSync(file, gzipSync(Buffer.from(text, 'utf8'), { level: 6 }));
      appendFileSync(
        'data/raw_pages.ndjson',
        JSON.stringify({
          content_hash: createHash('sha256').update(text).digest('hex'),
          url: BASE + path,
          kind,
          http_status: res.status,
          fetched_at: new Date().toISOString(),
          path: file,
          byte_size: Buffer.byteLength(text),
          authenticated: true,
        }) + '\n',
      );
      if (res.status !== 200 && !tolerate.includes(res.status)) {
        throw new Error(`HTTP ${res.status} for ${path}`);
      }
      return JSON.parse(text);
    }
    throw new Error(`failed after retries: ${path}`);
  }

  /** Full question row, including premium statements and editorials. */
  async getQuestion(ref: string) {
    // 'view' pace: get_question is the ONLY call that counts against the
    // 150/hour content-view cap, so it carries the slow ~26s throttle.
    const r = await this.json(
      `/api/proxy/question?action=get_question&question_ref=${encodeURIComponent(ref)}`,
      'q',
      true,
      [],
      'view',
    );
    return r?.data ?? null;
  }

  /**
   * MCQ stems, options and the correct answer. Only meaningful for question_type=mcq.
   *
   * Mock-OA questions return 403 `mock_oa_answer_locked`: the site withholds a
   * mock test's answer key until the attempt is submitted. That is a deliberate
   * assessment control, so we record it and move on -- the question's statement
   * is still valid data and was already paid for in quota.
   */
  async getMcqItems(numericId: number): Promise<{ items: any[]; locked: boolean }> {
    const r = await this.json(
      `/api/proxy/question-mcq-items?action=get_mcq_items_with_answers&question_id=${numericId}`,
      'mcq',
      true,
      [403],
    );
    if (r?.status === 'error') {
      return { items: [], locked: r?.code === 'mock_oa_answer_locked' };
    }
    return { items: (r?.data ?? []) as any[], locked: false };
  }

  /**
   * Image references for a question: {id, uploaded_at} only, never bytes.
   * Call it only when the question payload says has_image, to avoid spending
   * requests (and possibly quota) on the ~70% that have none.
   */
  async getImages(ref: string) {
    const r = await this.json(
      `/api/proxy/question_images?action=get_question_images&question_ref=${encodeURIComponent(ref)}`,
      'img',
    );
    return (r?.data ?? []) as { id: number; uploaded_at: string }[];
  }

  /** The URL an image's bytes would be served from, if ever needed. */
  static imageUrl(id: number) {
    return `${BASE}/api/proxy/serve_image?id=${id}&v=orig`;
  }

  async premiumStatus() {
    const r = await this.json('/api/proxy/premium?action=check_premium_status', 'premium', false);
    return r?.data ?? null;
  }
}
