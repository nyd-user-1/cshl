// Ingest the APS RSS feeds (PRC firehose + PRC sections + PRL Nuclear Physics)
// into the nsr table.
//
//   node --env-file=.env.local scripts/ingest-aps-feeds.mjs
//
// Two effects, both idempotent:
//   1. Papers already in NSR (matched by DOI): fill `abstract` where NULL.
//      Nothing else on an NSR row is touched. Feed abstracts are ~300-char
//      teasers ending in '…' — the later S2/OpenAlex sweep overwrites those
//      with full text (WHERE abstract LIKE '%…').
//   2. Papers NOT in NSR: new row with key_number = DOI, is_nsr = false,
//      full citation metadata, and the feed item preserved in `raw`
//      ({source:'aps-feed', ...}). If NSR later indexes the paper, the
//      monthly dump refresh should promote the row (match by DOI, replace
//      key_number with the NSR key, set is_nsr = true) — see docs.
//
// Cron-able: feeds cover ~4 weeks (firehose) to ~13 months (quiet sections),
// so any cadence up to weekly never misses a paper.

import { spawn } from "node:child_process";

const FEEDS = [
  "http://feeds.aps.org/rss/recent/prc.xml",
  "http://feeds.aps.org/rss/tocsec/PRC-NuclearAstrophysics.xml",
  "http://feeds.aps.org/rss/tocsec/PRC-NuclearReactions.xml",
  "http://feeds.aps.org/rss/tocsec/PRC-NuclearStructure.xml",
  "http://feeds.aps.org/rss/tocsec/PRC-RelativisticNuclearCollisions.xml",
  // NOT recent/prl.xml — full PRL carries all of physics; only its nuclear slice belongs here
  "http://feeds.aps.org/rss/tocsec/PRL-NuclearPhysics.xml",
];

// NSR journal codes (journals dictionary), so non-NSR rows join cleanly
const JOURNAL_CODES = { "Phys. Rev. C": "PRVCA", "Phys. Rev. Lett.": "PRLTA" };

const url = new URL(process.env.DATABASE_URL_UNPOOLED ?? "");
const PG_ENV = {
  ...process.env,
  PGHOST: url.hostname, PGPORT: url.port || "5432",
  PGDATABASE: url.pathname.slice(1),
  PGUSER: decodeURIComponent(url.username),
  PGPASSWORD: decodeURIComponent(url.password),
  PGSSLMODE: "require",
};

function psql(stdinText) {
  return new Promise((resolve, reject) => {
    const child = spawn("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1"], { env: PG_ENV });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (c) => (c === 0 ? resolve(out) : reject(new Error(`psql exit ${c}: ${err.slice(0, 1500)}`))));
    child.stdin.write(stdinText);
    child.stdin.end();
  });
}

function csvField(v) {
  if (v === null || v === undefined) return "";
  let s = String(v).replace(/\u0000/g, "").replace(/[\r\n]+/g, " ");
  if (s === "") return '""';
  if (/[",]/.test(s)) s = `"${s.replaceAll('"', '""')}"`;
  return s;
}
const csvRow = (f) => f.map(csvField).join(",");

const unescapeXml = (s) =>
  s.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"')
   .replaceAll("&#39;", "'").replaceAll("&amp;", "&");
const stripTags = (s) => unescapeXml(s).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

function parseItems(xml, feed) {
  const out = [];
  for (const it of xml.match(/<item .*?<\/item>/gs) ?? []) {
    const get = (re) => it.match(re)?.[1] ?? null;
    const doi = get(/<prism:doi>([^<]+)<\/prism:doi>/);
    if (!doi) continue;
    const ce = get(/<content:encoded><!\[CDATA\[(.*?)\]\]><\/content:encoded>/s) ?? "";
    const paras = [...ce.matchAll(/<p>(.*?)<\/p>/gs)].map((m) => stripTags(m[1]));
    const source = get(/<dc:source>([^<]*)<\/dc:source>/);
    const journal = source?.match(/^(.*?)\s+\d+,/)?.[1] ?? null;
    const authors = (paras[0] ?? "")
      .replace(/^Author\(s\):\s*/, "")
      .replace(/,?\s+and\s+/g, "; ").replaceAll(", ", "; ") || null;
    out.push({
      doi,
      title: stripTags(get(/<title>(.*?)<\/title>/s) ?? ""),
      date: get(/<dc:date>([^<]+)<\/dc:date>/)?.slice(0, 10) ?? null,
      section: get(/<prism:section>([^<]+)<\/prism:section>/),
      source, journal,
      authors,
      abstract: paras[1] || null,
      feed,
    });
  }
  return out;
}

// 1. fetch + parse + dedupe by DOI (tocsec items carry a section; prefer those)
const byDoi = new Map();
for (const feed of FEEDS) {
  try {
    const res = await fetch(feed);
    if (!res.ok) { console.error(`  ${feed}: HTTP ${res.status}, skipping`); continue; }
    const items = parseItems(await res.text(), feed);
    for (const r of items) {
      const prev = byDoi.get(r.doi);
      if (!prev || (!prev.section && r.section)) byDoi.set(r.doi, r);
    }
    console.log(`  ${feed.split("/").pop()}: ${items.length} items`);
  } catch (e) {
    console.error(`  ${feed}: ${e.message} — skipping`);
  }
  await new Promise((r) => setTimeout(r, 1000));
}
const records = [...byDoi.values()];
console.log(`unique papers: ${records.length}`);

// 2. stage and apply
const rows = records.map((r) =>
  csvRow([
    r.doi,
    r.date ? Number(r.date.slice(0, 4)) : null,
    r.title || null,
    r.authors,
    r.source,
    JOURNAL_CODES[r.journal] ?? null,
    r.abstract,
    JSON.stringify({ source: "aps-feed", feed: r.feed, section: r.section, fetched: new Date().toISOString().slice(0, 10) }),
  ]),
);

const out = await psql(`BEGIN;
CREATE TEMP TABLE stage_aps (
  doi text, pub_year int, title text, authors text, reference text,
  journal_code text, abstract text, raw jsonb
) ON COMMIT DROP;
COPY stage_aps FROM STDIN WITH (FORMAT csv);
${rows.join("\n")}
\\.

-- effect 1: abstracts for NSR rows that lack one (only that; NSR rows are theirs)
WITH filled AS (
  UPDATE nsr SET abstract = s.abstract
  FROM stage_aps s
  WHERE lower(nsr.doi) = lower(s.doi) AND nsr.abstract IS NULL AND s.abstract IS NOT NULL
  RETURNING nsr.key_number
) SELECT 'abstracts_filled: ' || count(*) FROM filled;

-- effect 2: new non-NSR rows for papers NSR has not indexed
WITH ins AS (
  INSERT INTO nsr (key_number, pub_year, title, authors, doi, reference,
                   journal_code, reference_type, is_primary, is_nsr, abstract, raw)
  SELECT DISTINCT ON (lower(doi)) doi, pub_year, title, authors, doi, reference,
         journal_code, 'JOURNAL', true, false, abstract, raw
  FROM stage_aps s
  WHERE pub_year IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM nsr n WHERE lower(n.doi) = lower(s.doi))
  ORDER BY lower(doi)
  ON CONFLICT (key_number) DO UPDATE SET abstract = coalesce(nsr.abstract, EXCLUDED.abstract)
  RETURNING key_number
) SELECT 'new_rows: ' || count(*) FROM ins;
COMMIT;`);
console.log(out.trim());
console.log("done");
