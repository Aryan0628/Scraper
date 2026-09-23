/**
 * Parser for Next.js App Router RSC "flight" payloads.
 *
 * Pages embed their data as self.__next_f.push([1,"<escaped>"]) chunks. Once
 * unescaped, the result is a stream of rows shaped `<hexid>:<payload>` with NO
 * delimiter between them -- a row marker butts straight against the previous
 * row's last byte, e.g.  ...questions"}1e:T752,<h3>Role: ...
 *
 * Text rows carry a `T<hexlen>,` prefix where hexlen is a BYTE count. Honouring
 * it is what keeps long fields intact; splitting on newlines or on /<hex>:/
 * truncates every editorial and interview narrative silently.
 *
 * Fields may hold "$<hexid>" pointers to another row (e.g. editorial, experience).
 */

export type Rows = Map<string, unknown>;

/** Pull the flight stream out of a page's HTML and unescape it. */
export function extractFlight(html: string): string {
  const chunks: string[] = [];
  const re = /self\.__next_f\.push\(\[1,\s*"((?:[^"\\]|\\.)*)"\]\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) chunks.push(m[1]);
  if (chunks.length === 0) return '';
  // Unescape the concatenation so escapes spanning a chunk boundary survive.
  try {
    return JSON.parse('"' + chunks.join('') + '"') as string;
  } catch {
    return chunks
      .map((c) => {
        try {
          return JSON.parse('"' + c + '"') as string;
        } catch {
          return c;
        }
      })
      .join('');
  }
}

/** End index (exclusive) of the JSON value starting at `start`. */
function scanJson(s: string, start: number): number {
  if (s[start] === '"') {
    let esc = false;
    for (let i = start + 1; i < s.length; i++) {
      const c = s[i];
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') return i + 1;
    }
    return s.length;
  }
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return s.length;
}

const ROW_MARKER = /([0-9a-f]{1,8}):/g;

function nextRowMarker(s: string, from: number): number {
  ROW_MARKER.lastIndex = from;
  const m = ROW_MARKER.exec(s);
  return m ? m.index : s.length;
}

/** Split the flight stream into its rows. */
export function tokenizeRows(flight: string): Rows {
  const rows: Rows = new Map();
  let i = 0;
  while (i < flight.length) {
    while (i < flight.length && (flight[i] === '\n' || flight[i] === '\r')) i++;
    const head = /^([0-9a-f]{1,8}):/.exec(flight.slice(i, i + 10));
    if (!head) {
      i++;
      continue;
    }
    const id = head[1];
    i += head[0].length;
    const tag = flight[i];

    if (tag === 'T') {
      const comma = flight.indexOf(',', i);
      const byteLen = parseInt(flight.slice(i + 1, comma), 16);
      const start = comma + 1;
      // byteLen counts UTF-8 bytes, which is not the JS string length.
      const text = Buffer.from(flight.slice(start), 'utf8')
        .subarray(0, byteLen)
        .toString('utf8');
      rows.set(id, text);
      i = start + text.length;
      continue;
    }

    const end =
      tag === '[' || tag === '{' || tag === '"'
        ? scanJson(flight, i)
        : nextRowMarker(flight, i);
    const raw = flight.slice(i, end);
    try {
      rows.set(id, JSON.parse(raw));
    } catch {
      rows.set(id, raw);
    }
    i = end;
  }
  return rows;
}

/** Replace "$<hexid>" pointers with the row they reference. */
export function resolveRefs(value: unknown, rows: Rows, depth = 0): unknown {
  if (depth > 12) return value;
  if (typeof value === 'string') {
    const m = /^\$([0-9a-f]{1,8})$/.exec(value);
    if (m && rows.has(m[1])) return resolveRefs(rows.get(m[1]), rows, depth + 1);
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => resolveRefs(v, rows, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveRefs(v, rows, depth + 1);
    return out;
  }
  return value;
}

/** Find the first value stored under `key` anywhere in the row table. */
export function findKey(rows: Rows, key: string): unknown {
  const seen = new Set<unknown>();
  const walk = (v: unknown): unknown => {
    if (!v || typeof v !== 'object') return undefined;
    if (seen.has(v)) return undefined;
    seen.add(v);
    if (!Array.isArray(v) && key in (v as Record<string, unknown>)) {
      return (v as Record<string, unknown>)[key];
    }
    for (const child of Object.values(v)) {
      const hit = walk(child);
      if (hit !== undefined) return hit;
    }
    return undefined;
  };
  for (const row of rows.values()) {
    const hit = walk(row);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** Convenience: html -> rows, with a resolver bound to them. */
export function parsePage(html: string) {
  const flight = extractFlight(html);
  const rows = tokenizeRows(flight);
  return {
    flight,
    rows,
    get: (key: string) => resolveRefs(findKey(rows, key), rows),
  };
}

/** Problem ids are base64 of "<id>|0"; interview ids are plain base64 of "<id>". */
export function decodeId(sourceId: string): number | null {
  const pad = sourceId + '='.repeat((4 - (sourceId.length % 4)) % 4);
  try {
    const decoded = Buffer.from(pad, 'base64').toString('utf8');
    const n = parseInt(decoded.split('|')[0], 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}
