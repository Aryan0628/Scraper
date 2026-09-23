/** Apply src/db/*.sql in order. Requires DATABASE_URL (see .env.example). */
import { readFileSync, readdirSync } from 'node:fs';
import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set. Copy .env.example and export it:');
  console.error('  export DATABASE_URL="postgresql://...neon.tech/oascraper?sslmode=require"');
  process.exit(1);
}
const sql = postgres(url, { onnotice: () => {} });
for (const file of readdirSync('src/db').filter((f) => f.endsWith('.sql')).sort()) {
  process.stdout.write(`applying ${file} ... `);
  await sql.unsafe(readFileSync(`src/db/${file}`, 'utf8'));
  console.log('ok');
}
const tables = await sql`
  SELECT table_schema, table_name FROM information_schema.tables
  WHERE table_schema IN ('core', 'ingest')
  ORDER BY table_schema, table_name`;
for (const s of ['core', 'ingest']) {
  const rows = tables.filter((t) => t.table_schema === s);
  console.log(`\n${s} (${rows.length}):`);
  for (const r of rows) console.log(`  ${r.table_name}`);
}
const mv = await sql`SELECT schemaname, matviewname FROM pg_matviews WHERE schemaname = 'core'`;
console.log(`\nmaterialized views (${mv.length}): ${mv.map((m) => m.matviewname).join(', ') || '(none)'}`);
await sql.end();
