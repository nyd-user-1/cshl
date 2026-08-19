// scripts/mine/mesh.mjs — the MeSH harvester (LANE-MINE task 2).
//
//   node --env-file=.env.local scripts/mine/mesh.mjs --probe [--n 200]
//   node --env-file=.env.local scripts/mine/mesh.mjs --run [--limit N]
//
// MeSH is the literal analog of NSR's expert keyword abstracts: NLM-indexer
// assigned, controlled, with qualifiers and major-topic flags — and, unlike
// NSR's flat keywords, hierarchical (every descriptor carries a D-number that
// walks the MeSH tree). It only reaches the ~49% of the corpus with a published
// journal DOI, which is exactly why it is a *classifier + query* source and not
// the backbone of the triplet set.
//
// Two candidate paths, both measured in --probe:
//   A. NCBI: DOI→PMID (idconv, 200/call — or esearch batched on [AID]) then
//      efetch db=pubmed (200 PMIDs/call, XML). Gives descriptor **UI codes**,
//      which is what makes the labels hierarchical.
//   B. Europe PMC: one batched DOI query, resultType=core, MeSH inline. One
//      round trip, but descriptor NAMES only — no D-numbers, no tree.
//
// Rate policy, verified empirically not from reputation: NCBI E-utilities allow
// 3 req/s without an api_key (10 with one; we have none and do not need one at
// this corpus size). Europe PMC publishes no hard ceiling and asks for restraint.

import {
  Pacer, fetchRetry, jsonlWriter, existingKeys, psqlRows, rowCounts,
  log, has, numArg, chunk, bareDoi, human, bytesOf, elapsed, sleep,
} from "./lib.mjs";
import { writeFileSync } from "node:fs";

const EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
const IDCONV = "https://pmc.ncbi.nlm.nih.gov/tools/idconv/api/v1/articles/";
const EPMC = "https://www.ebi.ac.uk/europepmc/webservices/rest/search";
const TOOL = "cshl-rxivgpt";
const EMAIL = process.env.OPENALEX_MAILTO || "brendan@nysgpt.com";
const NCBI_KEY = process.env.NCBI_API_KEY || "";

const OUT = "data/mine/mesh.jsonl";
const NCBI_RPS = numArg("--ncbi-rps", NCBI_KEY ? 8 : 2.5);   // 3/s is the unkeyed ceiling; sit under it
const EPMC_RPS = numArg("--epmc-rps", 3);
const N = numArg("--n", 200);

// ── minimal XML helpers ──────────────────────────────────────────────────────
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'" };
function decode(s) {
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&([a-zA-Z]+|#\d+);/g, (m, n) => (n in ENT ? ENT[n] : m));
}
const stripTags = (s) => decode(String(s).replace(/<[^>]*>/g, "")).trim();

// PubMed's XML is machine-generated against a frozen DTD, so a targeted scanner
// beats pulling in a parser — and it lets us skip the 90% of each record
// (abstract, authors, references) we do not want to hold in memory.
function parsePubmedArticles(xml) {
  const out = [];
  const re = /<PubmedArticle>([\s\S]*?)<\/PubmedArticle>/g;
  let m;
  while ((m = re.exec(xml))) {
    const rec = m[1];
    const pmid = (rec.match(/<PMID[^>]*>(\d+)<\/PMID>/) || [])[1] || null;
    const doi = (rec.match(/<ArticleId IdType="doi">([\s\S]*?)<\/ArticleId>/) || [])[1];
    const eloc = (rec.match(/<ELocationID EIdType="doi"[^>]*>([\s\S]*?)<\/ELocationID>/) || [])[1];
    const pmcid = (rec.match(/<ArticleId IdType="pmc">([\s\S]*?)<\/ArticleId>/) || [])[1] || null;
    const journal = stripTags((rec.match(/<Title>([\s\S]*?)<\/Title>/) || [])[1] || "") || null;

    const mesh = [];
    const mhList = (rec.match(/<MeshHeadingList>([\s\S]*?)<\/MeshHeadingList>/) || [])[1] || "";
    const mhRe = /<MeshHeading>([\s\S]*?)<\/MeshHeading>/g;
    let h;
    while ((h = mhRe.exec(mhList))) {
      const blk = h[1];
      const d = blk.match(/<DescriptorName UI="([^"]+)" MajorTopicYN="([YN])"[^>]*>([\s\S]*?)<\/DescriptorName>/);
      if (!d) continue;
      const quals = [];
      const qRe = /<QualifierName UI="([^"]+)" MajorTopicYN="([YN])"[^>]*>([\s\S]*?)<\/QualifierName>/g;
      let q;
      while ((q = qRe.exec(blk))) quals.push({ ui: q[1], name: decode(q[3]), major: q[2] === "Y" });
      mesh.push({ ui: d[1], descriptor: decode(d[3]), major: d[2] === "Y" || quals.some((x) => x.major), qualifiers: quals });
    }

    const kws = [];
    const kwRe = /<Keyword [^>]*>([\s\S]*?)<\/Keyword>/g;
    let k;
    while ((k = kwRe.exec(rec))) { const t = stripTags(k[1]); if (t) kws.push(t); }

    const pts = [];
    const ptRe = /<PublicationType UI="[^"]*">([\s\S]*?)<\/PublicationType>/g;
    let p;
    while ((p = ptRe.exec(rec))) pts.push(decode(p[1]));

    out.push({
      pmid, pmcid, journal,
      doi: bareDoi(doi || eloc || ""),
      mesh, author_keywords: [...new Set(kws)], publication_types: pts,
    });
  }
  return out;
}

// ── published DOIs from the corpus (read-only) ───────────────────────────────
async function publishedDois(limit) {
  const lim = limit ? `LIMIT ${limit}` : "";
  const rows = await psqlRows(
    `SELECT key_number, server, lower(published_doi)
       FROM preprints
      WHERE published_doi IS NOT NULL AND published_doi <> ''
      ORDER BY md5(key_number) ${lim};`
  );
  return rows.map(([key, server, doi]) => ({ key, server, doi: bareDoi(doi) }));
}

const eutilsBody = (extra) => {
  const p = new URLSearchParams({ tool: TOOL, email: EMAIL, ...extra });
  if (NCBI_KEY) p.set("api_key", NCBI_KEY);
  return p;
};

// ── DOI → PMID, path 1: the PMC id converter ─────────────────────────────────
async function idconvBatch(dois, pacer) {
  const url = new URL(IDCONV);
  url.searchParams.set("ids", dois.join(","));
  url.searchParams.set("format", "json");
  url.searchParams.set("tool", TOOL);
  url.searchParams.set("email", EMAIL);
  const res = await fetchRetry(url.toString(), { pacer });
  if (!res.ok || !res.json?.records) return new Map();
  const map = new Map();
  for (const r of res.json.records) {
    if (r.pmid) map.set(bareDoi(r["requested-id"] || r.doi), String(r.pmid));
  }
  return map;
}

// ── DOI → PMID, path 2: esearch on the [AID] field ───────────────────────────
// General where idconv is not: idconv only knows PMC-deposited articles, while
// esearch sees all of PubMed. Batched with OR, POSTed because the term is long.
async function esearchBatch(dois, pacer) {
  const term = dois.map((d) => `"${d}"[AID]`).join(" OR ");
  const res = await fetchRetry(`${EUTILS}/esearch.fcgi`, {
    pacer, method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: eutilsBody({ db: "pubmed", term, retmode: "json", retmax: String(dois.length * 2) }).toString(),
  });
  return res.ok && res.json?.esearchresult?.idlist ? res.json.esearchresult.idlist : [];
}

// ── PMIDs → MeSH ─────────────────────────────────────────────────────────────
async function efetchBatch(pmids, pacer) {
  const res = await fetchRetry(`${EUTILS}/efetch.fcgi`, {
    pacer, method: "POST", json: false, timeoutMs: 180_000,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: eutilsBody({ db: "pubmed", id: pmids.join(","), retmode: "xml" }).toString(),
  });
  if (!res.ok || !res.text) return { records: [], bytes: 0 };
  return { records: parsePubmedArticles(res.text), bytes: Buffer.byteLength(res.text) };
}

// ── Europe PMC one-step ──────────────────────────────────────────────────────
async function epmcBatch(dois, pacer) {
  const url = new URL(EPMC);
  url.searchParams.set("query", "(" + dois.map((d) => `DOI:"${d}"`).join(" OR ") + ")");
  url.searchParams.set("resultType", "core");
  url.searchParams.set("format", "json");
  url.searchParams.set("pageSize", String(Math.min(1000, dois.length)));
  const res = await fetchRetry(url.toString(), { pacer, timeoutMs: 180_000 });
  if (!res.ok || !res.json?.resultList) return { records: [], bytes: Buffer.byteLength(res.text || "") };
  const records = res.json.resultList.result.map((r) => ({
    pmid: r.pmid ? String(r.pmid) : null,
    pmcid: r.pmcid ?? null,
    journal: r.journalInfo?.journal?.title ?? null,
    doi: bareDoi(r.doi || ""),
    mesh: (r.meshHeadingList?.meshHeading || []).map((m) => ({
      ui: null,                                     // Europe PMC does not expose D-numbers
      descriptor: m.descriptorName,
      major: m.majorTopic_YN === "Y" || (m.meshQualifierList?.meshQualifier || []).some((q) => q.majorTopic_YN === "Y"),
      qualifiers: (m.meshQualifierList?.meshQualifier || []).map((q) => ({ ui: null, name: q.qualifierName, major: q.majorTopic_YN === "Y" })),
    })),
    author_keywords: r.keywordList?.keyword || [],
    publication_types: r.pubTypeList?.pubType || [],
  }));
  return { records, bytes: Buffer.byteLength(res.text || "") };
}

// ── probe ────────────────────────────────────────────────────────────────────
async function probe() {
  const counts = await rowCounts();
  log(`corpus: ${counts.preprints} preprints, ${counts.published} with a published DOI (${((counts.published / counts.preprints) * 100).toFixed(1)}%)`);
  const sample = await publishedDois(N);
  log(`probe sample: ${sample.length} published DOIs`);
  const dois = sample.map((s) => s.doi);
  const arms = {};

  // A1 — idconv
  {
    const pacer = new Pacer(NCBI_RPS, 2);
    const t0 = Date.now();
    let calls = 0;
    const map = new Map();
    for (const b of chunk(dois, 200)) { const m = await idconvBatch(b, pacer); calls++; for (const [k, v] of m) map.set(k, v); }
    arms.idconv = { name: "ncbi/idconv (200 DOIs/call)", calls, secs: (Date.now() - t0) / 1000, resolved: map.size, rate: map.size / dois.length, map };
  }
  // A2 — esearch
  {
    const pacer = new Pacer(NCBI_RPS, 2);
    const t0 = Date.now();
    let calls = 0; const pmids = [];
    for (const b of chunk(dois, 100)) { pmids.push(...await esearchBatch(b, pacer)); calls++; }
    arms.esearch = { name: "ncbi/esearch [AID] (100 DOIs/call)", calls, secs: (Date.now() - t0) / 1000, resolved: new Set(pmids).size, rate: new Set(pmids).size / dois.length, pmids: [...new Set(pmids)] };
  }
  // A3 — efetch over the union of PMIDs
  {
    const pacer = new Pacer(NCBI_RPS, 2);
    const union = new Set([...arms.idconv.map.values(), ...arms.esearch.pmids]);
    const t0 = Date.now();
    let calls = 0, bytes = 0; const recs = [];
    for (const b of chunk([...union], 200)) { const r = await efetchBatch(b, pacer); calls++; bytes += r.bytes; recs.push(...r.records); }
    const withMesh = recs.filter((r) => r.mesh.length).length;
    arms.efetch = {
      name: "ncbi/efetch pubmed (200 PMIDs/call)", calls, secs: (Date.now() - t0) / 1000, bytes,
      records: recs.length, withMesh, meshRate: withMesh / Math.max(1, recs.length),
      meshPer: recs.reduce((a, r) => a + r.mesh.length, 0) / Math.max(1, recs.length),
      kwPer: recs.reduce((a, r) => a + r.author_keywords.length, 0) / Math.max(1, recs.length),
      recs,
    };
  }
  // B — Europe PMC
  {
    const pacer = new Pacer(EPMC_RPS, 2);
    const t0 = Date.now();
    let calls = 0, bytes = 0; const recs = [];
    for (const b of chunk(dois, 50)) { const r = await epmcBatch(b, pacer); calls++; bytes += r.bytes; recs.push(...r.records); }
    const withMesh = recs.filter((r) => r.mesh.length).length;
    arms.epmc = {
      name: "europepmc/search core (50 DOIs/call)", calls, secs: (Date.now() - t0) / 1000, bytes,
      records: recs.length, withMesh, meshRate: withMesh / Math.max(1, recs.length),
      meshPer: recs.reduce((a, r) => a + r.mesh.length, 0) / Math.max(1, recs.length),
      kwPer: recs.reduce((a, r) => a + r.author_keywords.length, 0) / Math.max(1, recs.length),
      recs,
    };
  }

  const pad = (s, n) => String(s).padStart(n);
  log("");
  log("path                                 calls    secs   req/s   DOIs/s   resolved");
  for (const a of [arms.idconv, arms.esearch]) {
    log(`${a.name.padEnd(34)} ${pad(a.calls, 5)} ${pad(a.secs.toFixed(1), 7)} ${pad((a.calls / a.secs).toFixed(2), 7)} ${pad((dois.length / a.secs).toFixed(0), 8)} ${pad((a.rate * 100).toFixed(1) + "%", 10)}`);
  }
  for (const a of [arms.efetch, arms.epmc]) {
    log(`${a.name.padEnd(34)} ${pad(a.calls, 5)} ${pad(a.secs.toFixed(1), 7)} ${pad((a.calls / a.secs).toFixed(2), 7)} ${pad((a.records / a.secs).toFixed(0), 8)} ${pad(a.records, 10)}  mesh ${(a.meshRate * 100).toFixed(1)}% · ${a.meshPer.toFixed(1)}/rec · kw ${a.kwPer.toFixed(1)}/rec · ${human(a.bytes)}`);
  }

  // Cross-check: do the two sources agree on the descriptor sets?
  const byDoiN = new Map(arms.efetch.recs.map((r) => [r.doi, r]));
  const byDoiE = new Map(arms.epmc.recs.map((r) => [r.doi, r]));
  let both = 0, same = 0, nOnly = 0, eOnly = 0;
  for (const d of new Set([...byDoiN.keys(), ...byDoiE.keys()])) {
    const a = byDoiN.get(d), b = byDoiE.get(d);
    if (a?.mesh.length && b?.mesh.length) {
      both++;
      const A = new Set(a.mesh.map((m) => m.descriptor)), B = new Set(b.mesh.map((m) => m.descriptor));
      if (A.size === B.size && [...A].every((x) => B.has(x))) same++;
    } else if (a?.mesh.length) nOnly++;
    else if (b?.mesh.length) eOnly++;
  }
  log("");
  log(`cross-check: ${both} DOIs indexed by both · ${same} identical descriptor sets (${((same / Math.max(1, both)) * 100).toFixed(1)}%) · ncbi-only ${nOnly} · epmc-only ${eOnly}`);
  log(`end-to-end NCBI coverage of the published half: ${((arms.efetch.withMesh / dois.length) * 100).toFixed(1)}% of sampled published DOIs carry MeSH`);

  const sampleOut = arms.efetch.recs.filter((r) => r.mesh.length).slice(0, 3);
  writeFileSync("data/mine/raw/mesh-probe.json", JSON.stringify({
    n: dois.length, at: new Date().toISOString(),
    arms: Object.fromEntries(Object.entries(arms).map(([k, v]) => [k, { ...v, recs: undefined, map: undefined, pmids: undefined }])),
    crosscheck: { both, same, nOnly, eOnly },
    sample: sampleOut,
  }, null, 2));
  log(`wrote data/mine/raw/mesh-probe.json (${sampleOut.length} full records as evidence)`);
}

// ── full run ─────────────────────────────────────────────────────────────────
async function run() {
  const limit = numArg("--limit", 0);
  const all = await publishedDois(limit);
  const done = await existingKeys(OUT, "key");
  const todo = all.filter((r) => !done.has(r.key));
  log(`MeSH run: ${all.length} published DOIs, ${done.size} already harvested, ${todo.length} to go`);
  if (!todo.length) return;

  const out = jsonlWriter(OUT);
  const pacer = new Pacer(NCBI_RPS, 3);
  const byDoi = new Map(todo.map((r) => [r.doi, r]));
  let calls = 0, written = 0, withMesh = 0, unresolved = 0;

  // Chunk at 200 to match both idconv's and efetch's per-call ceiling, then run
  // several chunks in flight. The Pacer holds the aggregate under NCBI's rate
  // policy regardless of how many chunks are open, so concurrency buys wall-clock
  // without buying rudeness: the run becomes calls/rps-bound, not latency-bound.
  const batches = chunk(todo, 200);
  const queue = [...batches];
  const lanes = Math.max(1, numArg("--lanes", 4));
  log(`${batches.length} batches of ≤200 · ${lanes} lanes · ≤${NCBI_RPS} req/s aggregate · ~${Math.ceil((batches.length * 4) / NCBI_RPS / 60)} min projected`);

  const doBatch = async (b) => {
    const dois = b.map((r) => r.doi);
    const map = await idconvBatch(dois, pacer); calls++;

    // Whatever idconv could not place (non-PMC articles) goes to esearch, which
    // sees all of PubMed. Two paths, one merged PMID set.
    const missing = dois.filter((d) => !map.has(d));
    const extra = [];
    if (missing.length) { for (const mb of chunk(missing, 100)) { extra.push(...await esearchBatch(mb, pacer)); calls++; } }

    const pmids = [...new Set([...map.values(), ...extra])];
    if (!pmids.length) { unresolved += b.length; return; }
    const { records } = await efetchBatch(pmids, pacer); calls++;

    const hit = new Set();
    for (const r of records) {
      const src = byDoi.get(r.doi);
      if (!src) continue;                       // an esearch [AID] false-positive
      hit.add(r.doi);
      await out.write({
        key: src.key, server: src.server, published_doi: r.doi,
        pmid: r.pmid, pmcid: r.pmcid, journal: r.journal,
        mesh: r.mesh, author_keywords: r.author_keywords,
        publication_types: r.publication_types, source: "ncbi/efetch",
      });
      written++; if (r.mesh.length) withMesh++;
    }
    unresolved += dois.length - hit.size;
  };

  let lastLog = 0;
  await Promise.all(Array.from({ length: Math.min(lanes, queue.length) }, async () => {
    while (queue.length) {
      await doBatch(queue.shift());
      if (Date.now() - lastLog > 20_000) {
        lastLog = Date.now();
        log(`${written} written (${withMesh} with MeSH) · ${unresolved} unresolved · ${calls} calls · ${queue.length} batches left · ${(written / elapsed()).toFixed(0)} papers/s`);
      }
    }
  }));

  await out.drain(); await out.close();
  log(`mesh.jsonl: ${written} records · ${withMesh} with ≥1 descriptor (${((withMesh / Math.max(1, written)) * 100).toFixed(1)}%) · ${unresolved} published DOIs unresolved · ${human(bytesOf(OUT))}`);
}

const t = Date.now();
if (has("--probe")) await probe();
else if (has("--run")) await run();
else console.log("usage: mesh.mjs --probe [--n 200] | --run [--limit N]");
log(`done in ${((Date.now() - t) / 1000).toFixed(1)}s`);
