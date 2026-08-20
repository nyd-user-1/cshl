// scripts/mine/oakw.mjs — the OpenAlex keyword harvester + OAKW family (LANE-KEYWORDS).
//
//   node --env-file=.env.local scripts/mine/oakw.mjs --harvest
//   node --env-file=.env.local scripts/mine/oakw.mjs --stats
//   node --env-file=.env.local scripts/mine/oakw.mjs --pairs
//   node --env-file=.env.local scripts/mine/oakw.mjs --verify
//
// WHAT THIS IS. MESH reaches only the ~36% of the corpus with a MEDLINE-indexed
// published DOI, and AUTHORKW is a strict subset of that (127,406 papers with
// >=2 author keywords → 104,031 emitted pairs). Both are structurally capped by
// PubMed coverage, so the keyword-shaped supervision runs out exactly where the
// corpus is newest and most preprint-native. OpenAlex assigns keywords, topics
// and concepts to ~99% of these papers regardless of whether they were ever
// published, which is the gap this family fills.
//
// SOURCE. `preprint_openalex`, written by scripts/enrich-openalex-cshl.mjs. This
// file is READ-ONLY against the DB (scripts/mine/lib.mjs opens the session with
// default_transaction_read_only), and it trains nothing.
//
// SPLIT DISCIPLINE. Byte-identical to scripts/mine/assemble.mjs: the same h32,
// the same HOLDOUT_SEED/SPLIT_SEED, the same split-by-PAPER rule — imported from
// lib.mjs rather than restated, because two lanes that agree on a rule drift and
// two lanes that share one cannot.
//
// ONE DELIBERATE DIVERGENCE, and it is stricter. assemble.mjs splits on the
// query paper only, and lets a held-out paper appear as a NEGATIVE (its own
// comment argues that a distractor is not supervision about that document, and
// that argument is sound). LANE-KEYWORDS was given the harder rule: no paper
// under the holdout line may appear as an anchor, a positive, OR a negative.
// That rule is enforced here and RE-DERIVED FROM THE FILES in --verify — the
// disjointness against cshl-eval-v1 is computed, never asserted.
//
// This lane writes cshl-oakw-pairs.*.jsonl. It does not touch, rewrite, or read-
// modify-write cshl-query-pairs.*, cshl-triplets.*, cshl-*-classify.*, or
// anything under data/mine/eval/ — a training pipeline is live on those.

import {
  psqlRows, readJsonl, jsonlWriter, log, has, numArg, human, bytesOf,
  h32, HOLDOUT_SEED, SPLIT_SEED,
} from "./lib.mjs";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const MINE = "data/mine";
const EVAL = `${MINE}/eval`;
const RAW = `${MINE}/raw`;
const TEXT = `${MINE}/corpus-text.jsonl`;
const MESH = `${MINE}/mesh.jsonl`;
const OAKW = `${MINE}/oakw.jsonl`;
const DF = `${RAW}/oakw-df.json`;
const OUT_BASE = `${MINE}/cshl-oakw-pairs`;
mkdirSync(RAW, { recursive: true });
mkdirSync(EVAL, { recursive: true });

const HOLDOUT = numArg("--holdout", 0.25);
const NEG_TARGET = numArg("--negs", 8);
const PAGE = numArg("--page", 20000);

// Query-shaping knobs. Defaults were chosen from --stats on the real harvest,
// not from taste; the numbers behind each are in the run log and the manifest.
const KW_SCORE_MIN = numArg("--kw-score-min", 0.35);
const KW_DF_MAX = numArg("--kw-df-max", 0.02);   // drop a keyword on >2% of the corpus
const KW_MIN = numArg("--kw-min", 3);            // a 1–2 term query is not discriminative
const KW_MAX = numArg("--kw-max", 6);            // AUTHORKW parity
const TOPIC_SCORE_MIN = numArg("--topic-score-min", 0.5);

const isHeldOut = (key) => h32(`${HOLDOUT_SEED}${key}`) < HOLDOUT;
const splitOf = (key) => { const v = h32(`${SPLIT_SEED}:${key}`); return v < 0.8 ? "train" : v < 0.9 ? "val" : "test"; };

// Deterministic per-key PRNG — no Math.random anywhere in this file, same as
// assemble.mjs. A dataset you cannot regenerate byte-for-byte is not a dataset.
function rng(seed) {
  let h = parseInt(createHash("md5").update(seed).digest("hex").slice(0, 8), 16) >>> 0;
  return () => { h ^= h << 13; h >>>= 0; h ^= h >> 17; h ^= h << 5; h >>>= 0; return h / 0x100000000; };
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const c of createReadStream(path)) hash.update(c);
  return hash.digest("hex");
}

// ── P1: harvest preprint_openalex → oakw.jsonl ───────────────────────────────
// Paged by key_number so a 433k-row read never holds the whole table, and the
// jsonb columns are slimmed to the fields the query builder actually reads.
// psql runs -A -t, so each row arrives as one JSON string; JSON escapes tabs and
// newlines, so the tab field-separator is safe by construction.
async function harvest() {
  const w = jsonlWriter(OAKW, { append: false });
  let last = "", n = 0, withKw = 0, withTopics = 0, kwTotal = 0;
  for (;;) {
    const rows = await psqlRows(
      `SELECT jsonb_build_object(
         'key', key_number, 'doi', doi, 'oaid', openalex_id, 'type', work_type,
         'kw', oa_keywords, 'topics', oa_topics, 'ptopic', oa_primary_topic,
         'cited_by', cited_by)::text
       FROM preprint_openalex
       WHERE key_number > '${last.replace(/'/g, "''")}'
       ORDER BY key_number LIMIT ${PAGE};`
    );
    if (!rows.length) break;
    for (const [json] of rows) {
      const r = JSON.parse(json);
      last = r.key;
      n++;
      const kw = (r.kw ?? []).map((k) => [k.name, Math.round((k.score ?? 0) * 1000) / 1000]);
      const topics = (r.topics ?? []).map((t) => [t.name, t.score ?? null, t.subfield, t.field]);
      if (kw.length) { withKw++; kwTotal += kw.length; }
      if (topics.length) withTopics++;
      await w.write({ key: r.key, doi: r.doi, oaid: r.oaid, type: r.type, kw, topics, ptopic: r.ptopic, cited_by: r.cited_by });
    }
    if (n % 100000 < PAGE) log(`  ${n} papers…`);
  }
  await w.drain(); await w.close();
  log(`oakw.jsonl: ${n} papers · ${withKw} with keywords · ${withTopics} with topics · ${(kwTotal / Math.max(withKw, 1)).toFixed(2)} kw/paper · ${human(bytesOf(OAKW))}`);
}

// ── P2: stats — document frequency, noise, and the AUTHORKW overlap ──────────
// The DF table is the noise filter. OpenAlex's `keywords` are its legacy concept
// surface: every paper carries a handful of level-0/level-1 giants ("Biology",
// "Medicine", "Computer science") that are true of everything and therefore
// retrieve nothing. DF is what separates them from "Gene–environment
// interaction" — score does not (both sit near 0.5).
async function stats() {
  // DF is counted over the NORMALISED surface — the exact string filterKw emits —
  // and once per paper, so a term decorated two ways on one paper counts once.
  const df = new Map();
  let papers = 0, withKw = 0, kwTotal = 0, decorated = 0, collapsed = 0;
  const sample = [];
  for await (const r of readJsonl(OAKW)) {
    papers++;
    if (!r.kw?.length) continue;
    withKw++; kwTotal += r.kw.length;
    const here = new Set();
    for (const [rawName] of r.kw) {
      if (/\([^)]*\)\s*$/.test(rawName)) decorated++;
      const nm = normKw(rawName);
      if (!nm) continue;
      if (here.has(nm)) { collapsed++; continue; }
      here.add(nm);
      df.set(nm, (df.get(nm) ?? 0) + 1);
    }
    if (sample.length < 5 && r.kw.length >= 8) sample.push(r);
  }
  const entries = [...df.entries()].sort((a, b) => b[1] - a[1]);
  log(`corpus: ${papers} papers in oakw.jsonl · ${withKw} with >=1 keyword (${((withKw / papers) * 100).toFixed(2)}%)`);
  log(`  ${df.size} distinct keywords after parenthetical-stripping · ${(kwTotal / Math.max(withKw, 1)).toFixed(2)} mean keywords/paper · ${kwTotal} assignments`);
  log(`  ${decorated} assignments (${((decorated / kwTotal) * 100).toFixed(2)}%) carried a disambiguation parenthetical · ${collapsed} collapsed onto a sibling sense on the same paper`);

  log(`  top 25 by document frequency (these are what --kw-df-max ${KW_DF_MAX} removes):`);
  for (const [k, c] of entries.slice(0, 25)) log(`    ${String(((c / papers) * 100).toFixed(2)).padStart(6)}%  ${String(c).padStart(7)}  ${k}`);

  const cuts = [0.5, 0.2, 0.1, 0.05, 0.02, 0.01, 0.005];
  log(`  keywords surviving a DF ceiling:`);
  for (const c of cuts) {
    const kept = entries.filter(([, n]) => n / papers <= c);
    const keptAssign = kept.reduce((a, [, n]) => a + n, 0);
    log(`    df<=${String(c * 100).padStart(5)}%  ${String(kept.length).padStart(7)} distinct kept  ${((keptAssign / kwTotal) * 100).toFixed(1)}% of assignments survive`);
  }
  // A keyword seen once is a typo-grade tail, not supervision.
  const singles = entries.filter(([, n]) => n === 1).length;
  log(`    ${singles} keywords appear on exactly one paper (${((singles / df.size) * 100).toFixed(1)}% of the vocabulary)`);

  writeFileSync(DF, JSON.stringify({ papers, distinct: df.size, assignments: kwTotal, df: Object.fromEntries(entries) }));
  log(`  wrote ${DF} (${human(bytesOf(DF))})`);

  for (const r of sample.slice(0, 3)) {
    const kept = filterKw(r.kw, df, papers);
    log(`  e.g. ${r.key}`);
    log(`       raw   : ${r.kw.map(([k, s]) => `${k}(${s})`).join(", ").slice(0, 220)}`);
    log(`       query : ${kept.join("; ") || "(none survive)"}`);
  }

  // ── overlap with AUTHORKW ──────────────────────────────────────────────────
  // The whole point of the lane: does OpenAlex cover the papers PubMed does not?
  if (existsSync(MESH)) {
    const akw = new Set();
    for await (const m of readJsonl(MESH)) if ((m.author_keywords?.length ?? 0) >= 2) akw.add(m.key);
    let both = 0, oaOnly = 0, akwOnly = 0, neither = 0;
    const oaUsable = new Set();
    for await (const r of readJsonl(OAKW)) if (filterKw(r.kw ?? [], df, papers).length >= KW_MIN) oaUsable.add(r.key);
    for await (const r of readJsonl(OAKW)) {
      const a = akw.has(r.key), o = oaUsable.has(r.key);
      if (a && o) both++; else if (o) oaOnly++; else if (a) akwOnly++; else neither++;
    }
    log(`── overlap with AUTHORKW (papers with >=2 author keywords in mesh.jsonl) ──`);
    log(`  AUTHORKW-eligible papers        ${akw.size}`);
    log(`  OAKW-eligible papers (>=${KW_MIN} kw)  ${oaUsable.size}`);
    log(`  both                            ${both}`);
    log(`  OAKW only (the NEW supervision) ${oaOnly}`);
    log(`  AUTHORKW only (OA gives too few)${akwOnly}`);
    log(`  neither                         ${neither}`);
    log(`  OAKW covers ${((oaUsable.size / papers) * 100).toFixed(1)}% of the corpus vs AUTHORKW's ${((akw.size / papers) * 100).toFixed(1)}%`);
    writeFileSync(`${RAW}/oakw-overlap.json`, JSON.stringify({ authorkw_eligible: akw.size, oakw_eligible: oaUsable.size, both, oakw_only: oaOnly, authorkw_only: akwOnly, neither, papers }, null, 2));
  } else log(`  (no ${MESH} — AUTHORKW overlap skipped)`);
}

/**
 * Normalise a keyword to the string a person would actually type.
 *
 * OpenAlex decorates ~11.3% of the keywords it emits here with a disambiguation
 * parenthetical — "Locus (genetics)", "Transmission (telecommunications)". That
 * parenthetical is an internal sense label, not query text, and on this corpus it
 * is wrong more often than right: gated against each paper's own topic/subfield/
 * field vocabulary, only 17.3% of decorated terms carry a parenthetical from the
 * paper's own discipline. The failures are systematic and they are all
 * mis-disambiguations of a term whose BARE form is exactly the right query —
 * "Transmission (telecommunications)" on virology papers (1,418 in a 60k sample),
 * "Transcription (linguistics)" on genomics (599), "Schizophrenia (object-oriented
 * programming)" (259). Dropping those terms would throw away real signal;
 * stripping the sense label recovers it, and the terms whose bare form really is
 * contentless ("Set", "Task", "Range", "Variation") collapse into high-frequency
 * generics that the DF ceiling then removes on its own.
 *
 * This is why DF is computed over the NORMALISED surface: the filter has to score
 * the exact string that gets emitted, or the ceiling is measuring a vocabulary
 * the dataset never uses.
 */
export function normKw(name) {
  return String(name ?? "").replace(/\s*\([^)]*\)\s*$/, "").replace(/\s+/g, " ").trim();
}

/**
 * The query surface. Keep keywords that are (a) confidently assigned and (b)
 * specific enough to discriminate, take the top KW_MAX by score, preserve
 * OpenAlex's own score ordering — which is the order a searcher would rank them
 * in too, most salient first.
 */
function filterKw(kw, df, papers) {
  const out = [];
  const seen = new Set();
  for (const [rawName, score] of kw ?? []) {
    if (score < KW_SCORE_MIN) continue;
    const name = normKw(rawName);
    if (name.length < 3) continue;
    // Two decorated forms can normalise to one bare term on the same paper
    // ("Transmission (telecommunications)" + "Transmission (medicine)").
    const lc = name.toLowerCase();
    if (seen.has(lc)) continue;
    const d = df.get(name) ?? 0;
    if (d / papers > KW_DF_MAX) continue;
    if (d <= 1) continue;                      // singleton vocabulary: noise, not a query
    seen.add(lc);
    out.push(name);
    if (out.length >= KW_MAX) break;
  }
  return out;
}

/** Topic queries: the primary topic plus its siblings, deduped against subfield. */
function topicQuery(r) {
  const names = [];
  for (const [name, score] of (r.topics ?? []).map((t) => [t[0], t[1]])) {
    if (score != null && score < TOPIC_SCORE_MIN) continue;
    if (!names.includes(name)) names.push(name);
    if (names.length >= 3) break;
  }
  const sub = r.topics?.[0]?.[2];
  if (sub && !names.includes(sub)) names.push(sub);
  return names.length >= 2 ? names.join("; ") : null;
}

// ── P3: the OAKW family ──────────────────────────────────────────────────────
async function pairs() {
  if (!existsSync(DF)) throw new Error(`${DF} missing — run --stats first`);
  const dfRaw = JSON.parse(readFileSync(DF, "utf8"));
  const df = new Map(Object.entries(dfRaw.df));
  const dfPapers = dfRaw.papers;

  // corpus index: category + embeddability, exactly assemble.mjs's loadIndex.
  const cat = new Map(), byCat = new Map(), noEmbed = new Set();
  for await (const r of readJsonl(TEXT)) {
    if (r.embeddable === false) { noEmbed.add(r.key); continue; }
    const c = r.category || "uncategorized";
    cat.set(r.key, c);
    // Held-out papers are barred from EVERY role in this family, negatives
    // included, so they never enter the sampling pools at all.
    if (!isHeldOut(r.key)) (byCat.get(c) ?? byCat.set(c, []).get(c)).push(r.key);
  }
  log(`index: ${cat.size} embeddable papers · ${byCat.size} categories · ${noEmbed.size} unembeddable (barred as positives)`);

  // subfield pools + per-paper keyword sets, for the hard negative.
  //
  // Keyword names are INTERNED to integers before they are stored. 433k papers
  // × ~11.6 keywords is 5M string references, and JSON.parse mints a fresh
  // string per line rather than sharing one — holding the names themselves costs
  // roughly a gigabyte for a set-intersection test that only needs identity.
  const intern = new Map();
  const idOf = (s) => { let i = intern.get(s); if (i === undefined) { i = intern.size; intern.set(s, i); } return i; };
  const subOf = new Map(), bySub = new Map(), kwOf = new Map();
  let rows = 0;
  for await (const r of readJsonl(OAKW)) {
    rows++;
    const sub = r.topics?.[0]?.[2] ?? null;
    if (sub) {
      const si = idOf(`sub:${sub}`);
      subOf.set(r.key, si);
      if (cat.has(r.key) && !isHeldOut(r.key)) (bySub.get(si) ?? bySub.set(si, []).get(si)).push(r.key);
    }
    if (r.kw?.length) kwOf.set(r.key, new Set(r.kw.map(([nm]) => idOf(nm))));
  }
  log(`taxonomy: ${bySub.size} OpenAlex subfields · ${subOf.size} papers placed · ${kwOf.size} papers with >=1 keyword · ${intern.size} interned symbols`);

  const ws = Object.fromEntries(["train", "val", "test"].map((s) => [s, jsonlWriter(`${OUT_BASE}.${s}.jsonl`, { append: false })]));
  const held = jsonlWriter(`${OUT_BASE}.heldout.jsonl`, { append: false });
  const counts = { train: 0, val: 0, test: 0, held: 0 };
  const byFamily = {}, negSrc = {}, bySplitFamily = {};
  const drops = { unembeddable: 0, no_category: 0, too_few_kw: 0, no_topic: 0, thin_negatives: 0 };

  const emit = async (key, query, family, extra = {}) => {
    if (!query) return;
    if (noEmbed.has(key)) { drops.unembeddable++; return; }
    if (!cat.has(key)) { drops.no_category++; return; }
    const r = rng(`oakw:${family}:${key}:${query}`);
    const negatives = [];
    const mine = kwOf.get(key);

    // 1. same OpenAlex subfield, zero keyword overlap. Topically adjacent by the
    //    taxonomy, disjoint by the supervision — the hard negative this lane's
    //    own data affords, and a sharper one than "same author-chosen category".
    // `sub` is an interned integer and the first symbol interned is 0, so this
    // must test for undefined — a truthiness check silently strips the whole
    // first subfield's papers of their hard negatives.
    const sub = subOf.get(key);
    const subPool = (sub === undefined ? null : bySub.get(sub)) || [];
    if (subPool.length > 1) {
      for (let t = 0; t < NEG_TARGET * 8 && negatives.length < Math.ceil(NEG_TARGET / 2); t++) {
        const k = subPool[Math.floor(r() * subPool.length)];
        if (!k || k === key || negatives.some((x) => x.slug === k)) continue;
        const theirs = kwOf.get(k);
        if (mine && theirs) { let shared = false; for (const w of mine) if (theirs.has(w)) { shared = true; break; } if (shared) continue; }
        negatives.push({ slug: k, source: "oa-subfield-sibling" });
      }
    }
    // 2. same author-assigned category — always available, fills the rest.
    const pool = byCat.get(cat.get(key)) || [];
    for (let i = 0; i < NEG_TARGET * 8 && negatives.length < NEG_TARGET; i++) {
      const k = pool[Math.floor(r() * pool.length)];
      if (!k || k === key || negatives.some((x) => x.slug === k)) continue;
      negatives.push({ slug: k, source: "same-category" });
    }
    if (negatives.length < 2) { drops.thin_negatives++; return; }
    for (const nn of negatives) negSrc[nn.source] = (negSrc[nn.source] || 0) + 1;

    const rec = { query, positive: { slug: key }, negatives, meta: { family, category: cat.get(key), ...extra } };
    byFamily[family] = (byFamily[family] || 0) + 1;
    const bucket = isHeldOut(key) ? "heldout" : splitOf(key);
    (bySplitFamily[bucket] ??= {})[family] = ((bySplitFamily[bucket] ??= {})[family] || 0) + 1;
    if (isHeldOut(key)) { await held.write(rec); counts.held++; }
    else { const s = splitOf(key); await ws[s].write(rec); counts[s]++; }
  };

  for await (const r of readJsonl(OAKW)) {
    const kw = filterKw(r.kw ?? [], df, dfPapers);
    if (kw.length >= KW_MIN) await emit(r.key, kw.join("; "), "OAKW", { n_terms: kw.length, n_raw: (r.kw ?? []).length });
    else drops.too_few_kw++;

    const tq = topicQuery(r);
    if (tq) await emit(r.key, tq, "OATOPIC", { primary_topic: r.ptopic, subfield: r.topics?.[0]?.[2] ?? null, field: r.topics?.[0]?.[3] ?? null });
    else drops.no_topic++;
  }

  await Promise.all([...Object.values(ws), held].map(async (w) => { await w.drain(); await w.close(); }));
  log(`── cshl-oakw-pairs ── train ${counts.train} val ${counts.val} test ${counts.test} · heldout ${counts.held}`);
  log(`   families ${JSON.stringify(byFamily)}`);
  log(`   by split  ${JSON.stringify(bySplitFamily)}`);
  log(`   negatives ${JSON.stringify(negSrc)}`);
  log(`   drops ${JSON.stringify(drops)}  (of ${rows} papers read)`);
  await manifest({ counts, byFamily, bySplitFamily, negSrc, drops, rows, dfPapers, distinctKw: dfRaw.distinct });
}

async function manifest(m) {
  const files = {};
  for (const f of ["train", "val", "test", "heldout"]) {
    const p = `${OUT_BASE}.${f}.jsonl`;
    if (!existsSync(p)) continue;
    files[`cshl-oakw-pairs.${f}.jsonl`] = { rows: m.counts[f === "heldout" ? "held" : f], bytes: bytesOf(p), sha256: await sha256(p) };
  }
  const out = {
    name: "cshl-oakw-pairs",
    built_at: new Date().toISOString(),
    lane: "LANE-KEYWORDS",
    trains_nothing: true,
    corpus: "bioRxiv + medRxiv preprints — CSHL Neon project snowy-pine-70124980",
    source: {
      table: "preprint_openalex",
      writer: "scripts/enrich-openalex-cshl.mjs",
      api: "OpenAlex /works?filter=doi:… (100 DOIs/request, 1 credit each)",
      fields: "keywords[].display_name+score, topics[].display_name+score+subfield+field, primary_topic",
      why_not_s2: "Measured on a random 100-DOI sample: Semantic Scholar resolved 68/100 CSHL DOIs (OpenAlex 98/100) and its only keyword-shaped field is s2FieldsOfStudy — 13 coarse categories, mean 3.37/paper. OpenAlex supplies ~11.6 keywords over a vocabulary three orders of magnitude larger, at higher coverage. `tldr` is model-generated prose, which the SYNTH ruling already excluded. S2 adds no keyword field OpenAlex lacks, so it was not harvested.",
    },
    families: {
      OAKW: "OpenAlex keyword set, score- and DF-filtered, top-N by score, joined '; ' — the AUTHORKW analog at ~99% corpus coverage instead of PubMed's ~29%.",
      OATOPIC: "OpenAlex topic names + subfield, joined '; ' — from a curated 3,417-topic taxonomy rather than a free vocabulary.",
      OATOPIC_caveat: "OAKW is the headline family and OATOPIC is the weaker one; they are not equals. OpenAlex topic labels are sentence-shaped classification names ('Genetic Mapping and Diversity in Plants and Animals'), not strings a person would type into a search box, and a paper's three topics can read incoherently when concatenated. It is closer to a coarse multi-label classification target than to a query. It is emitted because it is free, clean, and covers 95.5% of the corpus — but any claim about closing the AUTHORKW gap should rest on OAKW.",
    },
    query_filters: {
      kw_score_min: KW_SCORE_MIN,
      kw_df_max: KW_DF_MAX,
      kw_df_max_note: "A keyword on more than this share of the corpus is dropped. OpenAlex's keyword surface is its legacy concept surface: every paper carries level-0/level-1 giants ('Biology', 'Medicine') that are true of everything and retrieve nothing. Score does not separate those from a real term — both sit near 0.5 — document frequency does.",
      kw_singleton_dropped: true,
      kw_min_terms: KW_MIN,
      kw_max_terms: KW_MAX,
      topic_score_min: TOPIC_SCORE_MIN,
    },
    split_rule: {
      fn: "parseInt(md5(seed + key_number).slice(0,8), 16) / 0xffffffff",
      holdout_seed: HOLDOUT_SEED, holdout_fraction: HOLDOUT,
      split_seed: SPLIT_SEED, splits: { train: "<0.8", val: "<0.9", test: "<=1.0" },
      shared_with: "scripts/mine/assemble.mjs — imported from scripts/mine/lib.mjs, not restated",
    },
    holdout_rule: {
      applies_to: ["positive", "negative"],
      statement: "No paper under the holdout line appears in any role in any training split of this family. This is STRICTER than assemble.mjs, which bars a held-out paper only from being the query; here held-out papers are removed from the negative-sampling pools before sampling begins.",
      verified_by: "scripts/mine/oakw.mjs --verify, which re-derives it from the files on disk rather than trusting these counters",
    },
    negatives: {
      "oa-subfield-sibling": "same OpenAlex subfield, zero keyword overlap with the positive",
      "same-category": "same author-assigned submission category",
      counts: m.negSrc,
    },
    text: {
      inlined: false,
      note: "Records carry slugs only. Title/abstract join from data/mine/corpus-text.jsonl on `key`, the same sidecar the other training families use.",
    },
    limitations: {
      residual_tagger_noise: {
        statement: "OpenAlex's keyword surface is machine-assigned and it mis-fires. After filtering, queries still contain terms the paper is not about — 'Curiosity' on a genetic-privacy paper, 'Variation' on a yeast-genetics paper.",
        measured: "11.34% of emitted terms carried a disambiguation parenthetical. Gated against each paper's own topic/subfield/field vocabulary, only 17.3% of those named a discipline the paper actually belongs to.",
        what_was_tried_and_rejected: [
          "Dropping parenthetical-decorated terms outright. Rejected: the decorated terms include the corpus's single best query strings — 'Coronavirus disease 2019 (COVID-19)' (24,065 papers) and 'Severe acute respiratory syndrome coronavirus 2' (11,340) are 100% decorated — and the frequent failures are mis-disambiguations of terms whose bare form is exactly right ('Transmission (telecommunications)' on virology, 5,714; 'Transcription (linguistics)' on genomics, 4,713).",
          "Using the corpus-wide decoration RATIO to separate contentless terms ('Set', 'Task', 'Function') from useful ones ('Transmission', 'Transcription'). Measured and REFUTED: of 2,649 terms with >=200 occurrences, 289 are always decorated, 2,357 never are, and only 3 are mixed. OpenAlex assigns one canonical surface form per concept id, so decoration is a property of the concept, not of usage, and carries no signal about a term's usefulness. Both 'Transmission' and 'Set' are 100% decorated.",
          "A hand-written stoplist of contentless English nouns. Not adopted: it is unmeasured author judgment injected into a data pipeline, and it would not survive an audit.",
        ],
        mitigation: "A query is a SET of 3-6 terms, so a single bad term dilutes rather than corrupts it. No frequency-based rule separates the residual noise, and that is stated here rather than papered over.",
      },
      machine_origin: "Every query in this family is machine-assigned, so by the standing ruling that the retrieval BENCHMARK is human-origin only (MESH + AUTHORKW), OAKW and OATOPIC are TRAINING-ONLY. cshl-oakw-pairs.heldout.jsonl exists so held-out papers are never trained on; it is not a benchmark and must not be scored as one.",
      coverage_gap: "6,480 of 433,449 papers (1.49%) are absent from OpenAlex entirely — confirmed as genuine 404s by a free by-DOI singleton sweep, not as a harvest failure. A further 34,503 enriched papers yield fewer than the 3 keywords a query needs after filtering.",
      not_in_this_family: "Text is not inlined and no eval file is produced. This lane emits training pairs only; it trains nothing and it does not touch cshl-query-pairs.*, cshl-triplets.*, cshl-*-classify.*, or data/mine/eval/.",
    },
    counts: { by_split: m.counts, by_family: m.byFamily, by_split_and_family: m.bySplitFamily, drops: m.drops, papers_read: m.rows },
    vocabulary: { distinct_keywords_before_filtering: m.distinctKw, papers_scored: m.dfPapers },
    files,
  };
  writeFileSync(`${OUT_BASE}.manifest.json`, JSON.stringify(out, null, 2));
  log(`   manifest → ${OUT_BASE}.manifest.json`);
  for (const [f, v] of Object.entries(files)) log(`   ${f.padEnd(34)} ${String(v.rows).padStart(8)} rows  ${human(v.bytes).padStart(9)}  sha256 ${v.sha256.slice(0, 16)}…`);
}

// ── P4: verify — every claim re-derived from the FILES ───────────────────────
async function verify() {
  const fail = [];
  const ok = (cond, msg) => { log(`  ${cond ? "PASS" : "FAIL"}  ${msg}`); if (!cond) fail.push(msg); };

  // The frozen benchmark's papers, ROLE BY ROLE, straight out of data/mine/eval.
  //
  // The roles have to be separated rather than lumped. cshl-eval-v1.docdoc is a
  // paper→paper task, so BOTH its `query` and its `positive` are papers, and a
  // scan that reads only one of them silently under-reports the benchmark's
  // footprint. Its positives are cited works, which assemble.mjs never required
  // to be held out — so unlike the queries, they can and do sit in the training
  // pool. Getting that distinction right is the difference between a real
  // disjointness number and a reassuring one.
  const benchQuery = new Set(), benchPositive = new Set(), benchNegative = new Set();
  for (const f of ["cshl-eval-v1.retrieval.jsonl", "cshl-eval-v1.docdoc.jsonl", "cshl-eval-v1.mesh-classify.jsonl", "cshl-eval-v1.category-classify.jsonl"]) {
    const p = `${EVAL}/${f}`;
    if (!existsSync(p)) { log(`  (missing ${f} — benchmark disjointness cannot be computed)`); continue; }
    for await (const r of readJsonl(p)) {
      // retrieval: query is a string, the paper is `positive`.
      // docdoc:    query is a paper object AND positive is a paper object.
      // classify:  the paper is the row itself, at `slug`.
      if (typeof r.query === "object" && r.query?.slug) benchQuery.add(r.query.slug);
      else if (typeof r.query === "string" && r.positive?.slug) benchQuery.add(r.positive.slug);
      else if (r.slug) benchQuery.add(r.slug);
      if (r.positive?.slug) benchPositive.add(r.positive.slug);
      for (const n of r.negatives || []) if (n.slug) benchNegative.add(n.slug);
    }
  }
  const benchAll = new Set([...benchQuery, ...benchPositive, ...benchNegative]);
  const benchHeld = new Set([...benchAll].filter(isHeldOut));
  const notHeldIn = (s) => [...s].filter((k) => !isHeldOut(k)).length;
  log(`── frozen benchmark cshl-eval-v1 ──`);
  log(`  ${benchAll.size} distinct papers across all roles · ${benchHeld.size} inside the holdout reservation`);
  log(`    as query    ${String(benchQuery.size).padStart(7)}  (${notHeldIn(benchQuery)} not held out)`);
  log(`    as positive ${String(benchPositive.size).padStart(7)}  (${notHeldIn(benchPositive)} not held out — docdoc positives are cited works, never reserved)`);
  log(`    as negative ${String(benchNegative.size).padStart(7)}  (${notHeldIn(benchNegative)} not held out — distractors are drawn from the training pool by design)`);
  ok(notHeldIn(benchQuery) === 0, `every benchmark QUERY paper is inside the holdout reservation (${notHeldIn(benchQuery)} outside)`);

  log(`── cshl-oakw-pairs split integrity ──`);
  const sets = {};
  const allRoles = new Set();
  for (const sp of ["train", "val", "test"]) {
    const path = `${OUT_BASE}.${sp}.jsonl`;
    if (!existsSync(path)) { log(`  (missing ${path})`); continue; }
    const keys = new Set();
    let n = 0, heldPos = 0, heldNeg = 0, wrongSplit = 0, selfNeg = 0, thin = 0, badFamily = 0, emptyQ = 0;
    for await (const r of readJsonl(path)) {
      n++;
      const k = r.positive?.slug;
      if (!k) continue;
      keys.add(k); allRoles.add(k);
      if (isHeldOut(k)) heldPos++;
      if (splitOf(k) !== sp) wrongSplit++;
      if (!r.query || typeof r.query !== "string" || !r.query.trim()) emptyQ++;
      if (!["OAKW", "OATOPIC"].includes(r.meta?.family)) badFamily++;
      const negs = (r.negatives || []).map((x) => x.slug);
      if (negs.includes(k)) selfNeg++;
      if (negs.length < 2) thin++;
      for (const s of negs) { allRoles.add(s); if (isHeldOut(s)) heldNeg++; }
    }
    sets[sp] = keys;
    log(`  ${("cshl-oakw-pairs." + sp).padEnd(30)} ${String(n).padStart(8)} records, ${String(keys.size).padStart(7)} distinct query papers`);
    ok(heldPos === 0, `${sp}: 0 held-out papers used as a positive (found ${heldPos})`);
    ok(heldNeg === 0, `${sp}: 0 held-out papers used as a NEGATIVE (found ${heldNeg}) — the strict rule`);
    ok(wrongSplit === 0, `${sp}: every record's split matches splitOf() (mismatches ${wrongSplit})`);
    ok(selfNeg === 0, `${sp}: no positive appears in its own negatives (found ${selfNeg})`);
    ok(thin === 0, `${sp}: every record carries >=2 negatives (found ${thin} thin)`);
    ok(emptyQ === 0, `${sp}: every record carries a non-empty string query (found ${emptyQ})`);
    ok(badFamily === 0, `${sp}: every record is OAKW or OATOPIC (found ${badFamily} other)`);
  }
  const [a, b, c] = ["train", "val", "test"].map((s) => sets[s]).filter(Boolean);
  if (a && b && c) {
    const inter = (x, y) => [...x].filter((k) => y.has(k)).length;
    ok(inter(a, b) === 0 && inter(a, c) === 0 && inter(b, c) === 0,
      `train/val/test query papers are pairwise disjoint (${inter(a, b)}/${inter(a, c)}/${inter(b, c)})`);
  }

  // ── the disjointness the lane was told to COMPUTE ──────────────────────────
  log(`── disjointness vs the frozen benchmark (computed from files, all roles) ──`);
  const inter = (s) => [...allRoles].filter((k) => s.has(k)).length;
  const hitHeld = inter(benchHeld), hitQ = inter(benchQuery), hitP = inter(benchPositive), hitN = inter(benchNegative), hitAny = inter(benchAll);
  log(`  papers appearing in any OAKW training role: ${allRoles.size}`);
  ok(hitHeld === 0, `∩ benchmark HELD-OUT papers (any role, either side) = ${hitHeld} (target 0)`);
  ok(hitQ === 0, `∩ benchmark QUERY papers = ${hitQ} (target 0)`);
  log(`  ∩ benchmark POSITIVE papers = ${hitP}   ∩ benchmark NEGATIVE papers = ${hitN}   ∩ any role = ${hitAny}`);
  log(`    Non-zero here is expected and is not a leak. cshl-eval-v1 draws its distractors, and docdoc's cited positives, from the un-reserved 75% of the corpus — 120,461 of its 160,000 negative slots hold a paper that was never held out. Those are corpus documents, and every retrieval benchmark indexes the whole corpus; what a benchmark reserves is QUERIES. Every benchmark query paper, and every benchmark paper of any role that falls inside the holdout reservation, is absent from this family. Reported, not suppressed.`);

  log(`── heldout file ──`);
  const hp = `${OUT_BASE}.heldout.jsonl`;
  if (existsSync(hp)) {
    let n = 0, notHeld = 0, negHeld = 0;
    for await (const r of readJsonl(hp)) {
      n++;
      if (!isHeldOut(r.positive?.slug)) notHeld++;
      for (const x of r.negatives || []) if (isHeldOut(x.slug)) negHeld++;
    }
    log(`  cshl-oakw-pairs.heldout.jsonl  ${n} records`);
    ok(notHeld === 0, `every held-out record's positive is genuinely held out (found ${notHeld})`);
    log(`  (its negatives are drawn from the training pool, same as cshl-eval-v1's: ${negHeld} held-out negatives)`);
  }

  log(`── manifest ──`);
  const mp = `${OUT_BASE}.manifest.json`;
  if (existsSync(mp)) {
    const m = JSON.parse(readFileSync(mp, "utf8"));
    for (const [f, v] of Object.entries(m.files)) {
      const p = `${MINE}/${f}`;
      const got = await sha256(p);
      ok(got === v.sha256, `${f}: sha256 on disk matches the manifest`);
      ok(bytesOf(p) === v.bytes, `${f}: byte count matches the manifest (${bytesOf(p)} vs ${v.bytes})`);
    }
  } else ok(false, `${mp} missing`);

  log(fail.length ? `── ${fail.length} FAILED ──` : `── all checks passed ──`);
  for (const f of fail) log(`  ! ${f}`);
  if (fail.length) process.exitCode = 1;
}

// ── main ─────────────────────────────────────────────────────────────────────
if (has("--harvest")) await harvest();
else if (has("--stats")) await stats();
else if (has("--pairs")) await pairs();
else if (has("--verify")) await verify();
else console.log("pick a phase: --harvest | --stats | --pairs | --verify");
