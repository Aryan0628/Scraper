import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Fetcher } from './fetcher.ts';

const SITEMAP = 'https://www.oahelper.in/sitemap.xml';
const CACHE = 'data/sitemap_urls.json';

export type UrlIndex = {
  all: string[];
  companies: string[];
  problems: string[];
  experiences: string[];
  mockOa: string[];
  /** problem source_id -> full url (the slug is not derivable from the title). */
  problemUrlById: Map<string, string>;
};

export async function discover(f: Fetcher, refresh = false): Promise<UrlIndex> {
  let urls: string[];
  if (!refresh && existsSync(CACHE)) {
    urls = JSON.parse(readFileSync(CACHE, 'utf8')) as string[];
  } else {
    const res = await f.get(SITEMAP, 'sitemap');
    urls = [...res.html.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) =>
      m[1].replace('https://www.oahelper.in', ''),
    );
    writeFileSync(CACHE, JSON.stringify(urls));
  }

  const problems = urls.filter((u) => /^\/problems\/[^/]+\//.test(u));
  const problemUrlById = new Map<string, string>();
  for (const u of problems) problemUrlById.set(u.split('/')[2], u);

  return {
    all: urls,
    // /company-questions/<slug> only -- exclude the /topics/<t> facet pages.
    companies: urls.filter((u) => /^\/company-questions\/[^/]+$/.test(u)),
    problems,
    experiences: urls.filter((u) => /^\/interview-experience\/[^/]+$/.test(u)),
    mockOa: urls.filter((u) => /^\/mock-oa\/[^/]+$/.test(u)),
    problemUrlById,
  };
}
