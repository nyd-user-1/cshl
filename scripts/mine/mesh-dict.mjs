// scripts/mine/mesh-dict.mjs — the MeSH VOCABULARY (LANE-MINE, lead directive).
//
//   node scripts/mine/mesh-dict.mjs --fetch     # one-time bulk download from NLM
//   node scripts/mine/mesh-dict.mjs --build     # → data/mine/mesh_dict.jsonl (+ qualifiers)
//   node scripts/mine/mesh-dict.mjs --stats
//
// Distinct from mesh.mjs, which harvests per-paper ASSIGNMENTS. This is the
// controlled vocabulary itself, and it buys three things the assignments alone
// cannot:
//   · canonical names + entry-term synonyms → the facet/dict surface, and a
//     synonym pool the query-pair generator can draw on so MeSH-as-query stops
//     being one fixed string per descriptor.
//   · tree numbers → tree DISTANCE, which turns "same branch, wrong leaf" into a
//     principled hard negative instead of a random same-category paper.
//   · hierarchy → a classifier eval that can score "wrong but close" separately
//     from "wrong and unrelated", which is the only honest way to grade a
//     hierarchical label set.
//
// The XML is a 313 MB one-time bulk file — no rate policy, no key, no pagination.
// It is parsed as a stream of records; the whole file is never in memory.

import { createReadStream, createWriteStream, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { jsonlWriter, readJsonl, log, has, strArg, human, bytesOf, UA } from "./lib.mjs";

const YEAR = strArg("--year", "2026");
const BASE = "https://nlmpubs.nlm.nih.gov/projects/mesh/MESH_FILES/xmlmesh";
const RAW = "data/mine/raw";
const DESC_XML = `${RAW}/desc${YEAR}.xml`;
const QUAL_XML = `${RAW}/qual${YEAR}.xml`;
const OUT_DESC = "data/mine/mesh_dict.jsonl";
const OUT_QUAL = "data/mine/mesh_qualifiers.jsonl";
mkdirSync(RAW, { recursive: true });

// ── entity decoding (same scanner discipline as mesh.mjs) ────────────────────
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decode = (s) => String(s)
  .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
  .replace(/&([a-zA-Z]+);/g, (m, n) => (n in ENT ? ENT[n] : m));
const one = (blk, tag) => { const m = blk.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`)); return m ? decode(m[1]).trim() : null; };
const many = (blk, tag) => { const out = []; const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g"); let m; while ((m = re.exec(blk))) out.push(decode(m[1]).trim()); return out; };

// ── fetch ────────────────────────────────────────────────────────────────────
async function fetchOne(url, dest) {
  if (existsSync(dest) && statSync(dest).size > 1000) { log(`${dest} already on disk (${human(bytesOf(dest))}) — skipping`); return; }
  log(`fetching ${url}`);
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
  log(`  → ${dest} ${human(bytesOf(dest))}`);
}
async function fetchAll() {
  await fetchOne(`${BASE}/desc${YEAR}.xml`, DESC_XML);
  await fetchOne(`${BASE}/qual${YEAR}.xml`, QUAL_XML);
}

// ── stream the file as a sequence of <Tag>…</Tag> records ────────────────────
async function* records(path, tag) {
  const open = `<${tag}`, close = `</${tag}>`;
  let buf = "";
  for await (const chunk of createReadStream(path, { encoding: "utf8", highWaterMark: 1 << 22 })) {
    buf += chunk;
    for (;;) {
      const a = buf.indexOf(open);
      if (a < 0) { buf = buf.slice(-close.length); break; }
      const b = buf.indexOf(close, a);
      if (b < 0) { buf = buf.slice(a); break; }
      yield buf.slice(a, b + close.length);
      buf = buf.slice(b + close.length);
    }
  }
}

// ── build ────────────────────────────────────────────────────────────────────
function parseTerms(rec, canonical) {
  // Every <String> inside a <Term> across every concept — MeSH's synonym set.
  const terms = new Set();
  const re = /<Term\b[\s\S]*?<String>([\s\S]*?)<\/String>[\s\S]*?<\/Term>/g;
  let m;
  while ((m = re.exec(rec))) { const t = decode(m[1]).trim(); if (t && t !== canonical) terms.add(t); }
  return [...terms];
}

async function build() {
  if (!existsSync(DESC_XML)) { log(`${DESC_XML} missing — run --fetch first`); return; }

  // qualifiers first: small, and descriptors reference them
  const qualByUi = new Map();
  {
    const out = jsonlWriter(OUT_QUAL, { append: false });
    let n = 0;
    for await (const rec of records(QUAL_XML, "QualifierRecord")) {
      const ui = one(rec, "QualifierUI");
      const name = one(rec.match(/<QualifierName>[\s\S]*?<\/QualifierName>/)?.[0] || "", "String");
      if (!ui || !name) continue;
      const row = {
        ui, name,
        abbreviation: one(rec, "Abbreviation"),
        tree_numbers: many(rec, "TreeNumber"),
        entry_terms: parseTerms(rec, name),
        scope_note: one(rec, "ScopeNote"),
      };
      qualByUi.set(ui, name);
      await out.write(row); n++;
    }
    await out.drain(); await out.close();
    log(`mesh_qualifiers.jsonl: ${n} qualifiers · ${human(bytesOf(OUT_QUAL))}`);
  }

  // descriptors — two passes over one streamed read is impossible, so pass 1
  // writes the rows and remembers only (tree number → ui), which is ~30k entries.
  const treeToUi = new Map();
  const rows = [];
  let n = 0, withTree = 0, terms = 0;
  for await (const rec of records(DESC_XML, "DescriptorRecord")) {
    const ui = one(rec, "DescriptorUI");
    const name = one(rec.match(/<DescriptorName>[\s\S]*?<\/DescriptorName>/)?.[0] || "", "String");
    if (!ui || !name) continue;
    const tree_numbers = many(rec, "TreeNumber");
    const entry_terms = parseTerms(rec, name);
    const allowable = [];
    const aq = /<QualifierUI>([^<]+)<\/QualifierUI>/g;
    let m; while ((m = aq.exec(rec))) allowable.push(m[1]);
    for (const t of tree_numbers) treeToUi.set(t, ui);
    rows.push({
      ui, name, tree_numbers, entry_terms,
      scope_note: one(rec, "ScopeNote"),
      allowable_qualifiers: [...new Set(allowable)].map((q) => ({ ui: q, name: qualByUi.get(q) ?? null })),
    });
    n++; if (tree_numbers.length) withTree++; terms += entry_terms.length;
    if (n % 10000 === 0) log(`  ${n} descriptors…`);
  }

  // pass 2 (in memory, ~30k rows): parents from the tree numbers. A descriptor
  // can sit at several places in the tree, so parents is a set, not a scalar.
  const out = jsonlWriter(OUT_DESC, { append: false });
  let roots = 0;
  for (const r of rows) {
    const parents = new Set();
    for (const t of r.tree_numbers) {
      const dot = t.lastIndexOf(".");
      if (dot < 0) { roots++; continue; }               // top of a MeSH category
      const p = treeToUi.get(t.slice(0, dot));
      if (p && p !== r.ui) parents.add(p);
    }
    r.parents = [...parents];
    r.depth = r.tree_numbers.length ? Math.min(...r.tree_numbers.map((t) => t.split(".").length)) : null;
    await out.write(r);
  }
  await out.drain(); await out.close();
  log(`mesh_dict.jsonl: ${n} descriptors · ${withTree} with tree numbers · ${terms} entry terms (${(terms / n).toFixed(1)}/descriptor) · ${roots} tree roots · ${human(bytesOf(OUT_DESC))}`);
  writeFileSync(`${RAW}/mesh-dict-stats.json`, JSON.stringify({ year: YEAR, descriptors: n, qualifiers: qualByUi.size, withTree, entryTerms: terms, at: new Date().toISOString() }, null, 2));
}

async function stats() {
  let n = 0, syn = 0, maxDepth = 0;
  const sample = [];
  for await (const r of readJsonl(OUT_DESC)) {
    n++; syn += r.entry_terms.length; maxDepth = Math.max(maxDepth, r.depth ?? 0);
    if (["D006801", "D000818", "D055088", "D017057"].includes(r.ui)) sample.push(r);
  }
  log(`${n} descriptors · ${syn} entry terms · max tree depth ${maxDepth}`);
  for (const r of sample) {
    log(`  ${r.ui} ${r.name} · depth ${r.depth} · trees ${r.tree_numbers.slice(0, 3).join(",")} · parents ${r.parents.join(",") || "(root)"}`);
    log(`      synonyms: ${r.entry_terms.slice(0, 5).join(" | ") || "(none)"}`);
  }
}

const t = Date.now();
if (has("--fetch")) await fetchAll();
if (has("--build")) await build();
if (has("--stats")) await stats();
if (!["--fetch", "--build", "--stats"].some(has)) console.log("usage: mesh-dict.mjs --fetch | --build | --stats");
log(`done in ${((Date.now() - t) / 1000).toFixed(1)}s`);
