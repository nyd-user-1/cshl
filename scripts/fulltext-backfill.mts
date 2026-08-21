// Backfill preprint_fulltext from a machine whose IP the origins tolerate.
//
//   npx tsx scripts/fulltext-backfill.mts <key_number> [<key_number> …]
//
// WHY THIS EXISTS. /api/chat fetches full text on demand, but from Vercel's
// shared egress IPs bioRxiv answers every request 429, and so do the Wayback
// Machine and r.jina.ai (measured 2026-08-21; medRxiv JATS succeeds). A
// residential IP passes all of them. This script runs the SAME ladder as the
// serverless path (api/_lib/fulltext.ts — one code path, no drift) and writes
// the same cache table, so the deployed chat's rung 1 serves the result.
//
// Be polite: sequential, one paper at a time. bioRxiv rate-limits a busy
// residential IP to ~1 request per 20 s once tripped.
import { neon } from "@neondatabase/serverless";
import { readFileSync } from "fs";
import { getFulltext } from "../api/_lib/fulltext.js";

const keys = process.argv.slice(2);
if (!keys.length) {
  console.error("usage: npx tsx scripts/fulltext-backfill.mts <key_number> …");
  process.exit(1);
}

const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const url = /^DATABASE_URL=(.+)$/m.exec(env)?.[1]?.trim().replace(/^"|"$/g, "");
if (!url) throw new Error("DATABASE_URL not found in .env.local");
const sql = neon(url);

for (const key of keys) {
  const rows = (await sql.query(
    `SELECT key_number, doi, server, version, jatsxml_url FROM preprints WHERE key_number = $1`,
    [key],
  )) as { key_number: string; doi: string | null; server: string | null; version: number | null; jatsxml_url: string | null }[];
  if (!rows.length) {
    console.log(`${key}: not in preprints — skipped`);
    continue;
  }
  // 60 s prompt budget = effectively "wait for the ladder"; cache write is
  // inside getFulltext.
  const got = await getFulltext(sql as never, rows, 60_000);
  const hit = got.find((g) => g.key_number === key);
  console.log(hit ? `${key}: ${hit.source}, ${hit.text.length} chars` : `${key}: every rung failed`);
}

// The cache INSERT inside getFulltext is fire-and-forget; give it a beat and
// then VERIFY — a backfill that trusts a success report is not a backfill.
await new Promise((r) => setTimeout(r, 3000));
for (const key of keys) {
  const check = (await sql.query(
    `SELECT source, length(text) AS chars FROM preprint_fulltext WHERE key_number = $1`,
    [key],
  )) as { source: string; chars: number }[];
  console.log(
    check.length
      ? `VERIFIED ${key}: cached (${check[0].source}, ${check[0].chars} chars)`
      : `NOT CACHED ${key}`,
  );
}
