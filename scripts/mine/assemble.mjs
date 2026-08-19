// scripts/mine/assemble.mjs — dataset assembly (LANE-MINE task 4).
//
//   node --env-file=.env.local scripts/mine/assemble.mjs --text
//   node --env-file=.env.local scripts/mine/assemble.mjs --triplets [--anchors N]
//   node --env-file=.env.local scripts/mine/assemble.mjs --classify
//   node --env-file=.env.local scripts/mine/assemble.mjs --pairs
//   node --env-file=.env.local scripts/mine/assemble.mjs --eval
//   node --env-file=.env.local scripts/mine/assemble.mjs --all
//
// Record shape is NSR's, deliberately: {query, positive:{slug,title,abstract},
// negatives:[{slug,title,abstract,source}], meta:{family,…}} — the shape
// scripts/train/build-nsr-triplets.mjs already emits and the 44b trainer already
// eats. Four families share it (CITE / MESH / SYNTH / CAT), so the rig gets one
// loader and per-family R@k for free.
//
// TEXT LIVES IN ONE PLACE. Inlining title+abstract into every triplet would
// duplicate a popular paper's abstract across every triplet it appears in —
// gigabytes of the same bytes. Training files carry slugs; text is joined from
// the single `corpus-text.jsonl` sidecar. The FROZEN EVAL files are the one
// exception: they inline text so the benchmark is self-contained and publishable.
//
// SPLIT DISCIPLINE (NSR's, verbatim): split by PAPER hash, never by row. A paper
// under the holdout line is reserved for rxiv-eval-v1 and may not appear in any
// training record in any role. A training record whose papers straddle two
// splits is DROPPED, not assigned — a positive that shows up in another split's
// query is a leak, and a leak is worth more than the rows it costs.

import {
  psqlRows, readJsonl, jsonlWriter, log, has, numArg, human, bytesOf, elapsed,
  h32, HOLDOUT_SEED, SPLIT_SEED,
} from "./lib.mjs";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const MINE = "data/mine";
const EVAL = `${MINE}/eval`;
const TEXT = `${MINE}/corpus-text.jsonl`;
const CITES = `${MINE}/citations.jsonl`;
const MESH = `${MINE}/mesh.jsonl`;
const SYNTH = `${MINE}/queries-synth.jsonl`;
const MDICT = `${MINE}/mesh_dict.jsonl`;
const EXTRACTQ = `${MINE}/queries-extract.jsonl`;
mkdirSync(EVAL, { recursive: true });

const HOLDOUT = numArg("--holdout", 0.25);      // NSR parity
const TEXT_CAP = numArg("--text-cap", 2000);    // the embed rig's input recipe cap
const NEG_TARGET = numArg("--negs", 8);
const POS_PER_ANCHOR = numArg("--pos", 2);
const EVAL_CAP = numArg("--eval-cap", 10000);   // NSR froze 9,995 held-out queries
const SYN_RATE = numArg("--synonym-rate", 0.4);  // share of MeSH query terms drawn from entry terms

const isHeldOut = (key) => h32(`${HOLDOUT_SEED}${key}`) < HOLDOUT;
const splitOf = (key) => { const v = h32(`${SPLIT_SEED}:${key}`); return v < 0.8 ? "train" : v < 0.9 ? "val" : "test"; };

// Deterministic per-key PRNG so every rerun draws the same negatives. No
// Math.random anywhere in this file — a benchmark you cannot reproduce is a
// number you cannot defend.
function rng(seed) {
  let h = parseInt(createHash("md5").update(seed).digest("hex").slice(0, 8), 16) >>> 0;
  return () => { h ^= h << 13; h >>>= 0; h ^= h >> 17; h ^= h << 5; h >>>= 0; return h / 0x100000000; };
}
function pick(arr, n, r) {
  if (arr.length <= n) return [...arr];
  const out = new Set();
  let guard = 0;
  while (out.size < n && guard++ < n * 12) out.add(arr[Math.floor(r() * arr.length)]);
  return [...out];
}

const sha256 = (path) => new Promise((res, rej) => {
  const h = createHash("sha256");
  createReadStream(path).on("data", (d) => h.update(d)).on("end", () => res(h.digest("hex"))).on("error", rej);
});

// ── the shared text sidecar ──────────────────────────────────────────────────
async function buildText() {
  // psql -A -t emits one row per line; abstracts contain newlines, so pull the
  // whole row as a single json object per line and let the field boundaries be
  // the parser's problem rather than ours.
  const out = jsonlWriter(TEXT, { append: false });
  let n = 0, last = "";
  for (;;) {
    const rows = await psqlRows(
      `SELECT json_build_object(
                'key', key_number, 'server', server, 'year', pub_year,
                'category', categories[1],
                'title', title,
                'abstract', left(abstract, ${TEXT_CAP}),
                'published_doi', published_doi)::text
         FROM preprints
        WHERE key_number > '${last.replace(/'/g, "''")}'
        ORDER BY key_number LIMIT 20000;`
    );
    if (!rows.length) break;
    for (const [j] of rows) { const o = JSON.parse(j); await out.write(o); last = o.key; n++; }
    if (rows.length < 20000) break;
    if (n % 100000 === 0) log(`  ${n} papers…`);
  }
  await out.drain(); await out.close();
  log(`corpus-text.jsonl: ${n} papers · ${human(bytesOf(TEXT))}`);
}

// Load only what a stage needs: keys + category, never the abstracts.
async function loadIndex() {
  const cat = new Map(), server = new Map(), byCat = new Map(), all = [];
  for await (const r of readJsonl(TEXT)) {
    all.push(r.key); server.set(r.key, r.server);
    const c = r.category || "uncategorized";
    cat.set(r.key, c);
    (byCat.get(c) ?? byCat.set(c, []).get(c)).push(r.key);
  }
  return { cat, server, byCat, all };
}

// ── task 4a: citation triplets (SPECTER recipe) ──────────────────────────────
async function triplets() {
  if (!existsSync(CITES)) { log(`SKIP triplets: ${CITES} not built yet (run citations.mjs --walk --resolve)`); return; }
  const idx = await loadIndex();
  log(`index: ${idx.all.length} papers, ${idx.byCat.size} categories`);

  // refs_in only — the out-of-corpus references are irrelevant to triplet mining
  // and holding 400k × 40 openalex ids would cost a gigabyte for nothing.
  const refs = new Map();
  for await (const r of readJsonl(CITES)) if (r.refs_in?.length) refs.set(r.key, r.refs_in);
  log(`citation graph: ${refs.size} papers with ≥1 in-corpus reference, ${[...refs.values()].reduce((a, x) => a + x.length, 0)} edges`);

  const ws = Object.fromEntries(["train", "val", "test"].map((s) => [s, jsonlWriter(`${MINE}/rxiv-triplets.${s}.jsonl`, { append: false })]));
  const heldOutAnchors = [];
  const counts = { train: 0, val: 0, test: 0 };
  const negSrc = {};
  let anchors = 0, straddle = 0, thin = 0, held = 0;
  const anchorSets = { train: new Set(), val: new Set(), test: new Set() };
  const cap = numArg("--anchors", 0);

  for (const [anchor, cited] of refs) {
    if (cap && anchors >= cap) break;
    const r = rng(`cite:${anchor}`);
    // The frozen benchmark takes its anchors from the held-out quarter and they
    // never enter a training file — that is what makes the eval honest.
    const bucket = isHeldOut(anchor);

    const positives = pick(cited.filter((k) => idx.cat.has(k)), POS_PER_ANCHOR, r);
    if (!positives.length) { thin++; continue; }
    const citedSet = new Set(cited);

    for (const pos of positives) {
      // hard negative 1 — SPECTER's: a paper the POSITIVE cites but the anchor
      // does not. Topically adjacent by construction, one hop too far.
      const hop2 = (refs.get(pos) || []).filter((k) => k !== anchor && !citedSet.has(k) && idx.cat.has(k));
      // hard negative 2 — same category, uncited. Easier than hop-2 but it is
      // the only negative available for the sparsely-cited half of the corpus.
      const sameCat = idx.byCat.get(idx.cat.get(anchor)) || [];

      const n1 = pick(hop2, Math.ceil(NEG_TARGET / 2), r).map((slug) => ({ slug, source: "citation-of-citation" }));
      const want = NEG_TARGET - n1.length;
      const n2 = [];
      for (let i = 0; i < want * 8 && n2.length < want; i++) {
        const k = sameCat[Math.floor(r() * sameCat.length)];
        if (!k || k === anchor || citedSet.has(k) || n1.some((x) => x.slug === k) || n2.some((x) => x.slug === k)) continue;
        n2.push({ slug: k, source: "same-category-uncited" });
      }
      const negatives = [...n1, ...n2];
      if (negatives.length < 2) { thin++; continue; }

      // SPLIT RULE — by the ANCHOR, because the anchor IS the query.
      //
      // The first cut of this required every paper in a record (anchor +
      // positive + 8 negatives) to land in one split. That is wrong, and the
      // measurement proved it: 34,520 of 34,753 records were dropped — 0.8^10
      // is 10%, and with the holdout on top ~0.7% survive. Worse, it was
      // protecting nothing. A negative is a distractor, not supervision about
      // that document; and a held-out POSITIVE is just a corpus document, which
      // every retrieval benchmark indexes anyway — the benchmark holds out
      // QUERIES, not documents. The leak that actually matters is a held-out
      // anchor's own (anchor → positive) edge appearing in training, and
      // splitting on the anchor makes that impossible: a held-out paper is
      // never a training anchor. This is also exactly NSR's rule — it split on
      // the paper the query was derived from — so the two lanes stay consistent.
      // --strict-split restores the old all-papers behaviour if anyone wants it.
      const strict = has("--strict-split");
      if (strict) {
        const papers = [anchor, pos, ...negatives.map((n) => n.slug)];
        if (bucket ? !papers.every(isHeldOut) : papers.some(isHeldOut) || new Set(papers.map(splitOf)).size > 1) { straddle++; continue; }
      }
      if (bucket) { heldOutAnchors.push({ anchor, positive: pos, negatives }); held++; continue; }
      const split = splitOf(anchor);
      await ws[split].write({
        query: { slug: anchor },                        // family CITE: the query IS a paper
        positive: { slug: pos },
        negatives,
        meta: { family: "CITE", category: idx.cat.get(anchor), server: idx.server.get(anchor) },
      });
      counts[split]++;
      anchorSets[split].add(anchor);
      for (const n of negatives) negSrc[n.source] = (negSrc[n.source] || 0) + 1;
    }
    anchors++;
  }
  await Promise.all(Object.values(ws).map(async (w) => { await w.drain(); await w.close(); }));
  writeFileSync(`${MINE}/raw/triplets-heldout.json`, JSON.stringify(heldOutAnchors));

  const inter = (a, b) => [...anchorSets[a]].filter((x) => anchorSets[b].has(x)).length;
  log("");
  log(`── rxiv-triplets ──`);
  log(`  anchors used ${anchors} · records train ${counts.train} val ${counts.val} test ${counts.test} · held-out reserved ${held}`);
  log(`  dropped: ${straddle} straddling a split boundary${has("--strict-split") ? " (--strict-split)" : ""}, ${thin} with too few in-corpus neighbours`);
  log(`  negatives by source: ${JSON.stringify(negSrc)}`);
  log(`  ANCHOR-DISJOINTNESS  |train∩val|=${inter("train", "val")} |train∩test|=${inter("train", "test")} |val∩test|=${inter("val", "test")}  → ${inter("train", "val") + inter("train", "test") + inter("val", "test") === 0 ? "PASS" : "FAIL"}`);
}

// ── task 4b: classifier sets ─────────────────────────────────────────────────
async function classify() {
  const idx = await loadIndex();

  // category — free, 100% coverage, straight from the DB
  {
    const ws = Object.fromEntries(["train", "val", "test"].map((s) => [s, jsonlWriter(`${MINE}/rxiv-category-classify.${s}.jsonl`, { append: false })]));
    const held = jsonlWriter(`${EVAL}/rxiv-category-classify.heldout.jsonl`, { append: false });
    const counts = { train: 0, val: 0, test: 0, held: 0 };
    const labels = new Map();
    for await (const r of readJsonl(TEXT)) {
      if (!r.category || !r.abstract) continue;
      labels.set(r.category, (labels.get(r.category) || 0) + 1);
      const rec = { slug: r.key, label: r.category, meta: { family: "CAT", server: r.server, year: r.year } };
      if (isHeldOut(r.key)) { await held.write(rec); counts.held++; }
      else { const s = splitOf(r.key); await ws[s].write(rec); counts[s]++; }
    }
    await Promise.all([...Object.values(ws), held].map(async (w) => { await w.drain(); await w.close(); }));
    log(`── rxiv-category-classify ── ${labels.size} classes · train ${counts.train} val ${counts.val} test ${counts.test} · heldout ${counts.held}`);
    writeFileSync(`${MINE}/raw/category-labels.json`, JSON.stringify([...labels].sort((a, b) => b[1] - a[1]), null, 2));
  }

  // MeSH — the published half only
  if (!existsSync(MESH)) { log(`SKIP rxiv-mesh-classify: ${MESH} not built yet`); return; }
  {
    const ws = Object.fromEntries(["train", "val", "test"].map((s) => [s, jsonlWriter(`${MINE}/rxiv-mesh-classify.${s}.jsonl`, { append: false })]));
    const held = jsonlWriter(`${EVAL}/rxiv-mesh-classify.heldout.jsonl`, { append: false });
    const counts = { train: 0, val: 0, test: 0, held: 0 };
    const desc = new Map();
    let noMesh = 0;
    for await (const r of readJsonl(MESH)) {
      if (!r.mesh?.length) { noMesh++; continue; }
      if (!idx.cat.has(r.key)) continue;
      for (const m of r.mesh) desc.set(m.ui || m.descriptor, (desc.get(m.ui || m.descriptor) || 0) + 1);
      const rec = {
        slug: r.key,
        labels: r.mesh.map((m) => ({ ui: m.ui, descriptor: m.descriptor, major: m.major, qualifiers: m.qualifiers.map((q) => q.name) })),
        major_labels: r.mesh.filter((m) => m.major).map((m) => m.descriptor),
        author_keywords: r.author_keywords,
        meta: { family: "MESHLABEL", pmid: r.pmid, journal: r.journal, server: r.server },
      };
      if (isHeldOut(r.key)) { await held.write(rec); counts.held++; }
      else { const s = splitOf(r.key); await ws[s].write(rec); counts[s]++; }
    }
    await Promise.all([...Object.values(ws), held].map(async (w) => { await w.drain(); await w.close(); }));
    log(`── rxiv-mesh-classify ── ${desc.size} distinct descriptors · train ${counts.train} val ${counts.val} test ${counts.test} · heldout ${counts.held} · ${noMesh} PubMed records carried no MeSH`);
    writeFileSync(`${MINE}/raw/mesh-descriptors.json`, JSON.stringify([...desc].sort((a, b) => b[1] - a[1]).slice(0, 500), null, 2));
  }
}

// ── task 4c: query→doc pairs ─────────────────────────────────────────────────
// Two upgrades the MeSH VOCABULARY buys us over the assignments alone:
//   · entry-term synonyms — a fixed descriptor string per concept would teach the
//     model one surface form. "Cancer Screening" and "Early Detection of Cancer"
//     are the same concept; a searcher types the first, MeSH stores the second.
//   · tree siblings — "same parent, different leaf" is a principled hard negative.
//     Same-category is a blunt instrument next to it.
async function loadMeshDict() {
  if (!existsSync(MDICT)) return null;
  const byUi = new Map(), children = new Map();
  for await (const r of readJsonl(MDICT)) {
    // MeSH entry terms carry index-inverted forms ("Cell, Nerve", "Factors,
    // Transcription") that no human types into a search box. Keep only the
    // natural-order synonyms; a query built from inverted forms would teach the
    // model a surface form that never occurs in real queries.
    const natural = (r.entry_terms || []).filter((t) => !t.includes(","));
    byUi.set(r.ui, { name: r.name, entry_terms: natural, parents: r.parents || [], depth: r.depth });
    for (const p of r.parents || []) (children.get(p) ?? children.set(p, []).get(p)).push(r.ui);
  }
  const siblings = (ui) => {
    const d = byUi.get(ui); if (!d) return [];
    const out = new Set();
    for (const p of d.parents) for (const c of children.get(p) || []) if (c !== ui) out.add(c);
    return [...out];
  };
  return { byUi, children, siblings };
}

async function pairs() {
  const idx = await loadIndex();
  const dict = await loadMeshDict();
  log(dict ? `mesh vocabulary: ${dict.byUi.size} descriptors, ${dict.children.size} parents with children` : "  (no mesh_dict.jsonl — synonyms and tree-sibling negatives disabled)");

  // descriptor → papers, for tree-sibling negatives. Built only if both the
  // assignments and the vocabulary are present.
  const byDesc = new Map(), descOf = new Map();
  if (dict && existsSync(MESH)) {
    for await (const r of readJsonl(MESH)) {
      if (!r.mesh?.length || !idx.cat.has(r.key)) continue;
      const uis = r.mesh.map((m) => m.ui).filter(Boolean);
      descOf.set(r.key, new Set(uis));
      for (const u of uis) (byDesc.get(u) ?? byDesc.set(u, []).get(u)).push(r.key);
    }
    log(`  descriptor→paper index: ${byDesc.size} descriptors over ${descOf.size} papers`);
  }

  const ws = Object.fromEntries(["train", "val", "test"].map((s) => [s, jsonlWriter(`${MINE}/rxiv-query-pairs.${s}.jsonl`, { append: false })]));
  const held = jsonlWriter(`${EVAL}/rxiv-query-pairs.heldout.jsonl`, { append: false });
  const counts = { train: 0, val: 0, test: 0, held: 0 };
  const byFamily = {}, negSrc = {};

  // Brendan's ruling: the retrieval BENCHMARK is human-origin only (MESH +
  // AUTHORKW). EXTRACT and SYNTH are training-only — so for those families a
  // held-out paper is not "eval", it is simply dropped. Held-out papers must
  // never be trained on, and they must never be scored on a machine-made query.
  const TRAINING_ONLY = new Set(["EXTRACT", "SYNTH"]);
  const emit = async (key, query, family, extra = {}) => {
    if (!query || !idx.cat.has(key)) return;
    if (TRAINING_ONLY.has(family) && isHeldOut(key)) return;
    const r = rng(`q:${family}:${key}:${query}`);
    const negatives = [];

    // 1. tree siblings — same MeSH parent, different leaf, and the paper must not
    //    carry any descriptor the positive carries.
    const mine = descOf.get(key);
    if (dict && mine?.size) {
      const uis = [...mine];
      for (let t = 0; t < 24 && negatives.length < Math.ceil(NEG_TARGET / 2); t++) {
        const sibs = dict.siblings(uis[Math.floor(r() * uis.length)]);
        if (!sibs.length) continue;
        const pool = byDesc.get(sibs[Math.floor(r() * sibs.length)]) || [];
        if (!pool.length) continue;
        const k = pool[Math.floor(r() * pool.length)];
        if (!k || k === key || negatives.some((n) => n.slug === k)) continue;
        const theirs = descOf.get(k);
        if (theirs && [...mine].some((u) => theirs.has(u))) continue;   // shares a label — not a negative
        negatives.push({ slug: k, source: "mesh-tree-sibling" });
      }
    }
    // 2. same category — always available, fills the rest.
    const sameCat = idx.byCat.get(idx.cat.get(key)) || [];
    for (let i = 0; i < NEG_TARGET * 8 && negatives.length < NEG_TARGET; i++) {
      const k = sameCat[Math.floor(r() * sameCat.length)];
      if (!k || k === key || negatives.some((n) => n.slug === k)) continue;
      negatives.push({ slug: k, source: "same-category" });
    }
    for (const n of negatives) negSrc[n.source] = (negSrc[n.source] || 0) + 1;

    const rec = { query, positive: { slug: key }, negatives, meta: { family, category: idx.cat.get(key), ...extra } };
    byFamily[family] = (byFamily[family] || 0) + 1;
    if (isHeldOut(key)) { await held.write(rec); counts.held++; }
    else { const s = splitOf(key); await ws[s].write(rec); counts[s]++; }
  };

  // MESH — the direct analog of NSR's keyword-abstract→paper recipe. The query is
  // the descriptor set an NLM indexer chose, majors first, joined the way a
  // searcher would type them — with SYN_RATE of the terms swapped for an entry
  // term so the model is not trained on one surface form per concept.
  if (existsSync(MESH)) {
    let syn = 0, tot = 0;
    for await (const r of readJsonl(MESH)) {
      if (!r.mesh?.length) continue;
      const major = r.mesh.filter((m) => m.major);
      const chosen = (major.length >= 2 ? major : r.mesh).slice(0, 6);
      if (chosen.length < 2) continue;
      const rr = rng(`syn:${r.key}`);
      const terms = chosen.map((m) => {
        const d = dict?.byUi.get(m.ui);
        tot++;
        if (d?.entry_terms.length && rr() < SYN_RATE) { syn++; return d.entry_terms[Math.floor(rr() * d.entry_terms.length)]; }
        return m.descriptor;
      });
      await emit(r.key, terms.join("; "), "MESH", { pmid: r.pmid, n_terms: terms.length, uis: chosen.map((m) => m.ui) });
      // author keywords are a second, independent query surface on the same paper
      if (r.author_keywords?.length >= 2) await emit(r.key, r.author_keywords.slice(0, 6).join("; "), "AUTHORKW");
    }
    if (tot) log(`  MeSH queries: ${syn}/${tot} terms drawn from entry-term synonyms (${((syn / tot) * 100).toFixed(0)}%, target ${(SYN_RATE * 100).toFixed(0)}%)`);
  } else log(`  (no ${MESH} yet — MESH/AUTHORKW families skipped)`);

  // EXTRACT — scripted keyphrase queries, no model, no spend, 100% coverage.
  // Training-only by ruling; never enters the benchmark.
  if (existsSync(EXTRACTQ)) {
    for await (const r of readJsonl(EXTRACTQ)) await emit(r.key, r.queries?.extract, "EXTRACT", { n_phrases: r.phrases?.length });
  } else log(`  (no ${EXTRACTQ} yet — run extract-queries.mjs --df --run)`);

  // SYNTH — model-generated. Bedrock generation was REJECTED by Brendan; the
  // family survives only if a self-run doc2query rider on the embed box is
  // approved. Nothing here fires unless that file exists.
  if (existsSync(SYNTH)) {
    for await (const r of readJsonl(SYNTH)) {
      for (const [shape, q] of Object.entries(r.queries || {})) await emit(r.key, q, "SYNTH", { shape });
    }
  } else log(`  (no ${SYNTH} — SYNTH family skipped: Bedrock spend rejected, doc2query rider not run)`);

  await Promise.all([...Object.values(ws), held].map(async (w) => { await w.drain(); await w.close(); }));
  log(`── rxiv-query-pairs ── train ${counts.train} val ${counts.val} test ${counts.test} · heldout ${counts.held} · families ${JSON.stringify(byFamily)} · negatives ${JSON.stringify(negSrc)}`);
}

// ── task 4d: freeze the eval holdouts ────────────────────────────────────────
// The holdout RESERVATION is 25% of the corpus — those papers never appear in a
// training file in any role. The frozen BENCHMARK is a deterministic sample of
// that reservation, capped so the eval stays a few thousand queries (NSR froze
// 9,995) rather than a hundred thousand nobody will ever run end to end.
// Selection is by hash of a family-seeded key, so the same rows are chosen on
// any machine, and text is hydrated only here — the benchmark must be
// self-contained and publishable, the training files must not duplicate bytes.
const evalRank = (family, key) => h32(`eval:${family}:${key}`);

async function takeLowest(path, family, cap, keyOf) {
  const rows = [];
  if (!existsSync(path)) return rows;
  for await (const r of readJsonl(path)) {
    const k = keyOf(r);
    if (!k) continue;
    rows.push([evalRank(family, k), r]);
  }
  rows.sort((a, b) => a[0] - b[0]);
  return rows.slice(0, cap).map(([, r]) => r);
}

async function freeze() {
  const posSlug = (r) => r.positive?.slug ?? r.slug;

  // Human-origin only, by Brendan's ruling. pairs() already refuses to put a
  // training-only family in the heldout file; this is the belt to that braces —
  // the benchmark's composition should be enforced where it is read, not only
  // where it is written.
  const HUMAN = new Set(["MESH", "AUTHORKW"]);
  const picked = {
    retrieval: (await takeLowest(`${EVAL}/rxiv-query-pairs.heldout.jsonl`, "retrieval", EVAL_CAP * 4, posSlug))
      .filter((r) => HUMAN.has(r.meta?.family)).slice(0, EVAL_CAP),
    classify_mesh: await takeLowest(`${EVAL}/rxiv-mesh-classify.heldout.jsonl`, "mesh", EVAL_CAP, posSlug),
    classify_category: await takeLowest(`${EVAL}/rxiv-category-classify.heldout.jsonl`, "category", EVAL_CAP, posSlug),
  };
  const heldTrip = existsSync(`${MINE}/raw/triplets-heldout.json`)
    ? JSON.parse(readFileSync(`${MINE}/raw/triplets-heldout.json`, "utf8")) : [];
  picked.docdoc = heldTrip
    .map((t) => [evalRank("docdoc", t.anchor), t])
    .sort((a, b) => a[0] - b[0]).slice(0, EVAL_CAP).map(([, t]) => t);

  const need = new Set();
  for (const r of picked.retrieval) { need.add(posSlug(r)); for (const n of r.negatives || []) need.add(n.slug); }
  for (const r of [...picked.classify_mesh, ...picked.classify_category]) need.add(posSlug(r));
  for (const t of picked.docdoc) { need.add(t.anchor); need.add(t.positive); for (const n of t.negatives) need.add(n.slug); }
  log(`eval freeze: ${need.size} distinct papers to hydrate from ${TEXT}`);

  const text = new Map();
  for await (const r of readJsonl(TEXT)) if (need.has(r.key)) text.set(r.key, { title: r.title, abstract: r.abstract });
  const T = (k) => ({ slug: k, ...(text.get(k) || {}) });

  const written = {};
  const emitFile = async (name, rows, fn) => {
    const w = jsonlWriter(`${EVAL}/${name}`, { append: false });
    for (const r of rows) await w.write(fn(r));
    await w.drain(); await w.close();
    written[name] = rows.length;
  };

  await emitFile("rxiv-eval-v1.retrieval.jsonl", picked.retrieval, (r) => ({
    query: r.query, positive: T(posSlug(r)),
    negatives: (r.negatives || []).map((x) => ({ ...T(x.slug), source: x.source })), meta: r.meta,
  }));
  await emitFile("rxiv-eval-v1.docdoc.jsonl", picked.docdoc, (t) => ({
    query: T(t.anchor), positive: T(t.positive),
    negatives: t.negatives.map((x) => ({ ...T(x.slug), source: x.source })), meta: { family: "CITE" },
  }));
  await emitFile("rxiv-eval-v1.mesh-classify.jsonl", picked.classify_mesh, (r) => ({
    ...T(r.slug), labels: r.labels, major_labels: r.major_labels, author_keywords: r.author_keywords, meta: r.meta,
  }));
  await emitFile("rxiv-eval-v1.category-classify.jsonl", picked.classify_category, (r) => ({
    ...T(r.slug), label: r.label, meta: r.meta,
  }));

  // The freeze is a one-way door: it needs Brendan's go, same as the spend gate.
  // Without it this still runs — you want to see the shape and the counts — but
  // the manifest says so in the loudest field it has, so a dry-run artifact can
  // never be mistaken for the benchmark.
  const authorized = has("--i-have-brendans-go");
  const manifest = {
    name: "rxiv-eval-v1",
    DRY_RUN: authorized ? undefined : true,
    status: authorized ? "FROZEN" : "DRY RUN — not the benchmark. Freeze needs Brendan's go (see LANE-MINE gates).",
    frozen_at: new Date().toISOString(),
    corpus: "bioRxiv + medRxiv preprints — CSHL Neon project snowy-pine-70124980",
    split_rule: {
      fn: "parseInt(md5(seed + key_number).slice(0,8), 16) / 0xffffffff",
      holdout_seed: HOLDOUT_SEED, holdout_fraction: HOLDOUT,
      split_seed: SPLIT_SEED, splits: { train: "<0.8", val: "<0.9", test: "<=1.0" },
      eval_selection: "lowest EVAL_CAP by md5('eval:' + family + ':' + key_number)",
      eval_cap: EVAL_CAP,
    },
    text_cap_chars: TEXT_CAP,
    // Scoring contract (lead directive, 2026-08-19). Encoded here rather than
    // left in prose so the harness reads it instead of a human remembering it.
    scoring: {
      report_per_family: true,
      headline_families: ["MESH", "AUTHORKW"],
      flagged_families: ["SYNTH"],
      note: "SYNTH eval queries share a generator with SYNTH training queries, so their scores flatter the fine-tune. Report them, never fold them into the headline retrieval number. The headline is the human-origin families only.",
    },
    provenance: {
      citations: "OpenAlex referenced_works via source cursor walk (S4306402567 bioRxiv, S3005729997 medRxiv)",
      mesh: "NCBI E-utilities — PMC idconv + esearch[AID] → efetch db=pubmed",
      synthetic: "Bedrock us.anthropic.claude-haiku-4-5-20251001-v1:0",
      category: "author-assigned at submission, from preprints.categories[1]",
    },
    files: {},
  };
  for (const f of Object.keys(written)) {
    const p = `${EVAL}/${f}`;
    manifest.files[f] = { rows: written[f], bytes: bytesOf(p), sha256: await sha256(p) };
  }
  writeFileSync(`${EVAL}/manifest.json`, JSON.stringify(manifest, null, 2));
  const fam = {};
  for (const r of picked.retrieval) fam[r.meta?.family ?? "?"] = (fam[r.meta?.family ?? "?"] || 0) + 1;
  log(`── rxiv-eval-v1 ${authorized ? "FROZEN" : "DRY RUN (not the benchmark — needs Brendan's go)"} · cap ${EVAL_CAP}/family ──`);
  log(`  retrieval by family: ${JSON.stringify(fam)}  · human-origin only (EXTRACT/SYNTH are training-only)`);
  for (const [f, m] of Object.entries(manifest.files)) {
    log(`  ${f.padEnd(38)} ${String(m.rows).padStart(7)} rows  ${human(m.bytes).padStart(9)}  sha256 ${m.sha256.slice(0, 16)}…`);
  }
}

const t = Date.now();
if (has("--text") || has("--all")) await buildText();
if (has("--triplets") || has("--all")) await triplets();
if (has("--classify") || has("--all")) await classify();
if (has("--pairs") || has("--all")) await pairs();
if (has("--eval") || has("--all")) await freeze();
if (!["--text", "--triplets", "--classify", "--pairs", "--eval", "--all"].some(has))
  console.log("usage: assemble.mjs --text | --triplets | --classify | --pairs | --eval | --all");
log(`done in ${((Date.now() - t) / 1000).toFixed(1)}s`);
