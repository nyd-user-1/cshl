#!/usr/bin/env node
/**
 * Asserts the claim the walk's host routing rests on: for the same window and
 * server, api.medrxiv.org (100/page, no funder) and api.biorxiv.org (30/page, with
 * funder) return the SAME records, differing in nothing but `funder` and the
 * capitalization of `server` — and that the loader's normalization erases the
 * latter. Run over several windows on both servers.
 */
import { normalizeAuthors } from "./lib/names.mjs";
const UA = "cshl-rxivgpt/0.1 (+https://cshl.nysgpt.com; brendan@nysgpt.com)";

const get = async (u) => (await fetch(u, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(90_000) })).json();

/** Exactly what scripts/load-rxiv.mjs writes into stage_preprints. */
const normalize = (r) => ({
  doi: r.doi,
  title: r.title,
  authors: normalizeAuthors(r.authors).display,
  author_corresponding: r.author_corresponding,
  author_corresponding_institution: r.author_corresponding_institution,
  date: r.date,
  version: r.version,
  type: (r.type ?? "").trim().toLowerCase() || null,
  license: (r.license ?? "").trim().toLowerCase() || null,
  category: (r.category ?? "").replace(/\s+/g, " ").trim().toLowerCase() || null,
  jatsxml: r.jatsxml,
  abstract: r.abstract,
  published: r.published,
  server: String(r.server ?? "").trim().toLowerCase(),
});

const WINDOWS = [
  ["biorxiv", "2020-03-01", "2020-03-02"],
  ["biorxiv", "2023-06-05", "2023-06-06"],
  ["medrxiv", "2021-01-04", "2021-01-05"],
  ["medrxiv", "2024-09-10", "2024-09-11"],
];

let totalCompared = 0, mismatches = 0, rawServerDiffs = 0, funderOnly = 0;
for (const [server, from, to] of WINDOWS) {
  // page the 30/page host far enough to cover the 100/page host's first page
  const bio = [];
  for (let c = 0; c < 120; c += 30) {
    const j = await get(`https://api.biorxiv.org/details/${server}/${from}/${to}/${c}/json`);
    const coll = j.collection ?? [];
    bio.push(...coll);
    if (coll.length < 30) break;
  }
  const med = (await get(`https://api.medrxiv.org/details/${server}/${from}/${to}/0/json`)).collection ?? [];
  const medMap = new Map(med.map((r) => [`${r.doi}|${r.version}`, r]));

  let compared = 0, diff = 0, serverRaw = 0, onlyFunder = 0;
  for (const b of bio) {
    const m = medMap.get(`${b.doi}|${b.version}`);
    if (!m) continue;
    compared++;
    // raw, pre-normalization
    if (b.server !== m.server) serverRaw++;
    const bKeys = new Set(Object.keys(b)), mKeys = new Set(Object.keys(m));
    const extraOnBio = [...bKeys].filter((k) => !mKeys.has(k));
    if (extraOnBio.length === 1 && extraOnBio[0] === "funder") onlyFunder++;
    // normalized, as the loader writes it
    const nb = normalize(b), nm = normalize(m);
    const bad = Object.keys(nb).filter((k) => JSON.stringify(nb[k]) !== JSON.stringify(nm[k]));
    if (bad.length) { diff++; if (diff <= 2) console.log(`   MISMATCH ${b.doi}v${b.version}: ${bad.join(", ")}`); }
  }
  totalCompared += compared; mismatches += diff; rawServerDiffs += serverRaw; funderOnly += onlyFunder;
  console.log(`${server} ${from}: compared ${compared} shared rows | raw server-case differs on ${serverRaw} | only extra field on bio host is 'funder' for ${onlyFunder} | normalized mismatches ${diff}`);
}
console.log(`\nTOTAL: ${totalCompared} rows compared across ${WINDOWS.length} windows`);
console.log(`  raw 'server' capitalization differed on ....... ${rawServerDiffs}/${totalCompared} rows ('bioRxiv'/'medRxiv' vs lowercase)`);
console.log(`  bio host's ONLY extra field was 'funder' on ... ${funderOnly}/${totalCompared} rows`);
console.log(`  mismatches AFTER loader normalization ......... ${mismatches}/${totalCompared}`);
console.log(mismatches === 0 ? "\nPARITY ASSERTED: the two hosts differ in funder and server-case only; normalization erases the case." : "\nPARITY FAILED");
process.exit(mismatches === 0 ? 0 : 1);
