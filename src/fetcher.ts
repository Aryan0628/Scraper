import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { appendFileSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';

export type FetchResult = {
  url: string;
  status: number;
  html: string;
  contentHash: string;
  fromCache: boolean;
  authenticated: boolean;
};

export type FetcherOpts = {
  minIntervalMs?: number;
  rawDir?: string;
  storageStatePath?: string;
  /** Re-use an existing snapshot instead of re-requesting. */
  cache?: boolean;
};

/** Cookie header lifted from a Playwright storageState dump, if present. */
function loadCookieHeader(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    const state = JSON.parse(readFileSync(path, 'utf8')) as {
      cookies?: { name: string; value: string; domain: string }[];
    };
    const jar = (state.cookies ?? []).filter((c) => c.domain.includes('oahelper.in'));
    if (!jar.length) return null;
    return jar.map((c) => `${c.name}=${c.value}`).join('; ');
  } catch {
    return null;
  }
}

export class Fetcher {
  private lastAt = 0;
  private minInterval: number;
  private rawDir: string;
  private cookieHeader: string | null;
  private cache: boolean;
  private manifest: string;
  public requests = 0;

  constructor(opts: FetcherOpts = {}) {
    this.minInterval = opts.minIntervalMs ?? 700;
    this.rawDir = opts.rawDir ?? 'data/raw';
    this.cache = opts.cache ?? true;
    this.cookieHeader = loadCookieHeader(opts.storageStatePath ?? '.secrets/storageState.json');
    mkdirSync(this.rawDir, { recursive: true });
    this.manifest = 'data/raw_pages.ndjson';
  }

  get authenticated(): boolean {
    return this.cookieHeader !== null;
  }

  private async throttle() {
    // Serial by design: this runs against one account, so concurrency 1 only.
    const wait = this.minInterval - (Date.now() - this.lastAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait + Math.random() * 250));
    this.lastAt = Date.now();
  }

  async get(url: string, kind: string): Promise<FetchResult> {
    const key = createHash('sha256').update(url).digest('hex').slice(0, 16);
    const path = `${this.rawDir}/${kind}_${key}.html.gz`;

    if (this.cache && existsSync(path)) {
      const html = (await import('node:zlib')).gunzipSync(readFileSync(path)).toString('utf8');
      return {
        url,
        status: 200,
        html,
        contentHash: createHash('sha256').update(html).digest('hex'),
        fromCache: true,
        authenticated: this.authenticated,
      };
    }

    let lastErr = '';
    for (let attempt = 1; attempt <= 4; attempt++) {
      await this.throttle();
      this.requests++;
      try {
        const headers: Record<string, string> = { Accept: 'text/html' };
        if (this.cookieHeader) headers.Cookie = this.cookieHeader;
        const res = await fetch(url, {
          headers,
          redirect: 'follow',
          signal: AbortSignal.timeout(30_000),
        });
        if (res.status === 429 || res.status >= 500) {
          lastErr = `HTTP ${res.status}`;
          await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
          continue;
        }
        const html = await res.text();
        const contentHash = createHash('sha256').update(html).digest('hex');
        // Snapshot first, always -- re-parsing must never need the network again.
        writeFileSync(path, gzipSync(Buffer.from(html, 'utf8'), { level: 6 }));
        appendFileSync(
          this.manifest,
          JSON.stringify({
            content_hash: contentHash,
            url,
            kind,
            http_status: res.status,
            fetched_at: new Date().toISOString(),
            path,
            byte_size: Buffer.byteLength(html),
            authenticated: this.authenticated,
          }) + '\n',
        );
        return {
          url,
          status: res.status,
          html,
          contentHash,
          fromCache: false,
          authenticated: this.authenticated,
        };
      } catch (e) {
        lastErr = String(e);
        await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
      }
    }
    throw new Error(`fetch failed after 4 attempts: ${url} (${lastErr})`);
  }
}
