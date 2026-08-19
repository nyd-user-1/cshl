// scripts/mine/extract-queries.mjs — the EXTRACT query family (lead directive,
// after Brendan rejected the Bedrock per-token bill).
//
//   node scripts/mine/extract-queries.mjs --df        # pass 1: corpus IDF
//   node scripts/mine/extract-queries.mjs --run       # pass 2: → queries-extract.jsonl
//   node scripts/mine/extract-queries.mjs --validate  # 20 papers + title-echo audit
//
// No model, no API, no spend, 100% corpus coverage. Training-only — the
// retrieval benchmark stays human-origin (MeSH + author keywords).
//
// Design note, because it is the whole point: candidate phrases are drawn from
// the ABSTRACT ONLY, never the title. That is not a shortcut, it is the
// guarantee — a query built from title words is a title paraphrase, which is
// exactly the failure mode that makes a retrieval model learn title matching.
// Scoring is IDF-weighted RAKE: RAKE's within-document degree/frequency finds
// the phrases a document is *about*, corpus IDF kills the phrases every
// biomedical abstract shares ("statistical significance", "these results").

import { readJsonl, jsonlWriter, log, has, numArg, human, bytesOf, elapsed, h32 } from "./lib.mjs";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const TEXT = "data/mine/corpus-text.jsonl";
const DF = "data/mine/raw/extract-df.json";
const OUT = "data/mine/queries-extract.jsonl";

const TOP = numArg("--top", 5);          // phrases per query
const MIN_DF = numArg("--min-df", 5);    // a term seen in <5 papers is a typo or an accession id
const MAX_LEN = numArg("--max-phrase", 3);

// Stopwords do double duty here: they are the phrase DELIMITERS (RAKE's trick —
// a candidate phrase is whatever sits between two stopwords), and they are
// excluded from scoring. The academic-boilerplate half matters as much as the
// grammatical half.
const STOP = new Set(`a about above after again against all also although am an and any are as at be because been before
being below between both but by can cannot could did do does doing done due during each either else few for from further
had has have having he her here hers herself him himself his how however i if in into is it its itself just may me might
more most much must my myself neither no nor not now of off on once only or other others ought our ours ourselves out
over own per rather same she should since so some such than that the their theirs them themselves then there these they
this those though through thus to too under until up upon us very was we were what when where whether which while who
whom whose why will with within without would you your yours yourself yourselves
we here study studies show shows shown showed suggest suggests suggesting demonstrate demonstrates demonstrated report
reports reported observe observed find finds found reveal reveals revealed indicate indicates indicated result results
resulting data using use used uses analysis analyses approach method methods paper work present presents presented
provide provides provided based important novel new recent significant significantly increase increased decrease
decreased high higher low lower large small number levels level effect effects role between during compared comparison
respectively addition addition conclusion conclusions background objective purpose aim aims however therefore moreover
furthermore overall total whereas via across among along toward towards likely potential potentially may might could
one two three first second third finally thereby hence given well also non pre post anti multi
measure measures determine determines identify identifies contain contains encode encodes yield yields require
requires display displays avoid avoids initiate initiates bridge bridges ascribe ascribes reveal allow allows enable
enables include includes remain remains become becomes appear appears exhibit exhibits perform performs obtain obtains
apart farther further across whether within among various several many few little much able unable known unknown
different similar same common rare specific general strong weak good poor better best worse early late long short
whole full partial single multiple additional current previous following above below overall along toward`.split(/\s+/));

// Two artifacts in the source abstracts, both fixed here rather than worked
// around: bioRxiv ships LITERAL backslash-n sequences (two characters, not a
// newline), and it runs section headers into the following word
// ("Summary statementHeliconius butterflies"). Split the case transition before
// lowercasing or the glued token survives as one nonsense term.
const norm = (s) => String(s || "")
  .replace(/\\[nrt]/g, " ")
  .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
  .toLowerCase()
  .replace(/[^a-z0-9\s-]+/g, " ");

// -ly adverbs are never part of a search query ("directly measure", "reliably
// identify", "illegally harvested") — treat them as phrase delimiters, same as
// stopwords. -ing is deliberately NOT filtered: in this domain gerunds are
// nouns (sequencing, imaging, binding, folding, signaling).
const isWord = (w) => w.length > 2 && w.length < 32 && !STOP.has(w) && !/^\d+$/.test(w) && !/ly$/.test(w);

// A candidate that starts or ends in a past participle is an abstract fragment,
// not a query — "exons located farther", "wood harvested". Trim the edges down
// to the noun core; drop the candidate if nothing is left.
const trimEdges = (p) => {
  let a = 0, b = p.length;
  while (a < b && /ed$/.test(p[a])) a++;
  while (b > a && /ed$/.test(p[b - 1])) b--;
  return p.slice(a, b);
};

// ── pass 1: document frequency over the whole corpus ─────────────────────────
async function buildDf() {
  const df = new Map();
  let n = 0;
  for await (const r of readJsonl(TEXT)) {
    if (!r.abstract) continue;
    const seen = new Set();
    for (const w of norm(r.abstract).split(/\s+/)) if (isWord(w)) seen.add(w);
    for (const w of seen) df.set(w, (df.get(w) || 0) + 1);
    n++;
    if (n % 100000 === 0) log(`  ${n} abstracts, ${df.size} terms…`);
  }
  const kept = [...df].filter(([, c]) => c >= MIN_DF);
  writeFileSync(DF, JSON.stringify({ docs: n, min_df: MIN_DF, df: Object.fromEntries(kept) }));
  log(`df: ${n} abstracts · ${df.size} distinct terms · ${kept.length} kept at df≥${MIN_DF} · ${human(bytesOf(DF))}`);
}

function loadDf() {
  const j = JSON.parse(readFileSync(DF, "utf8"));
  const N = j.docs;
  const df = new Map(Object.entries(j.df));
  // A term absent from the pruned table is rarer than MIN_DF, so it gets the
  // idf of a MIN_DF term rather than infinity — otherwise every typo and
  // accession number in an abstract would outrank the real subject matter.
  const floor = Math.log(N / j.min_df);
  return { N, idf: (w) => { const d = df.get(w); return d ? Math.log(N / d) : floor; } };
}

// ── phrase extraction ────────────────────────────────────────────────────────
const push = (out, cur) => { if (!cur.length) return; const t = trimEdges(cur); if (t.length) out.push(t); };

function phrases(abstract) {
  const out = [];
  for (const sentence of String(abstract).split(/[.;:!?()\[\]]+/)) {
    let cur = [];
    for (const raw of norm(sentence).split(/\s+/)) {
      if (!raw) continue;
      if (isWord(raw)) { cur.push(raw); if (cur.length === MAX_LEN) { push(out, cur); cur = []; } }
      else { push(out, cur); cur = []; }
    }
    push(out, cur);
  }
  return out;
}

function extract(abstract, idf, top) {
  const cands = phrases(abstract);
  if (!cands.length) return [];
  // RAKE: deg(w) counts how many candidate-phrase words co-occur with w,
  // freq(w) how often it appears. deg/freq rewards words that live inside long
  // specific phrases over words that appear alone everywhere.
  const freq = new Map(), deg = new Map();
  for (const p of cands) for (const w of p) {
    freq.set(w, (freq.get(w) || 0) + 1);
    deg.set(w, (deg.get(w) || 0) + p.length - 1);
  }
  const scored = new Map();
  for (const p of cands) {
    const key = p.join(" ");
    if (scored.has(key)) continue;
    let s = 0;
    for (const w of p) s += ((deg.get(w) + freq.get(w)) / freq.get(w)) * idf(w);
    scored.set(key, s / Math.pow(p.length, 0.6));
  }
  const ranked = [...scored].sort((a, b) => b[1] - a[1]);
  // Drop a phrase whose words are already covered — otherwise the top-5 is five
  // rewordings of the same noun phrase and the query says one thing five times.
  const used = new Set(), picked = [];
  for (const [p] of ranked) {
    const ws = p.split(" ");
    if (ws.every((w) => used.has(w))) continue;
    picked.push(p); ws.forEach((w) => used.add(w));
    if (picked.length === top) break;
  }
  return picked;
}

// ── title-echo audit, same measure used on the Bedrock validation ────────────
function overlap(query, title) {
  const t = new Set(norm(title).split(/\s+/).filter(isWord));
  const q = norm(query).split(/\s+/).filter(isWord);
  return q.length ? q.filter((w) => t.has(w)).length / q.length : 0;
}

async function validate() {
  const { idf } = loadDf();
  const n = numArg("--n", 20);
  const rows = [];
  for await (const r of readJsonl(TEXT)) {
    if (!r.abstract || !r.title) continue;
    if (h32(`extract-sample:${r.key}`) > n / 20000) continue;   // deterministic thin sample
    const ph = extract(r.abstract, idf, TOP);
    if (!ph.length) continue;
    rows.push({ key: r.key, title: r.title, category: r.category, query: ph.join("; ") });
    if (rows.length >= n) break;
  }
  let ov = 0;
  for (const r of rows) { r.overlap = overlap(r.query, r.title); ov += r.overlap; }
  log(`${rows.length} papers · mean title-overlap ${((ov / rows.length) * 100).toFixed(1)}% (Bedrock SYNTH measured 33.5%)`);
  for (const r of rows.slice(0, 6)) {
    log(`── ${r.key} [${r.category}] overlap ${(r.overlap * 100).toFixed(0)}%`);
    log(`   title: ${String(r.title).slice(0, 92)}`);
    log(`   query: ${r.query}`);
  }
  writeFileSync("data/mine/raw/extract-validate.json", JSON.stringify({ n: rows.length, meanOverlap: ov / rows.length, rows }, null, 2));
  log(`wrote data/mine/raw/extract-validate.json`);
}

async function run() {
  const { idf } = loadDf();
  const out = jsonlWriter(OUT, { append: false });
  let n = 0, empty = 0, ov = 0;
  for await (const r of readJsonl(TEXT)) {
    if (!r.abstract) { empty++; continue; }
    const ph = extract(r.abstract, idf, TOP);
    if (ph.length < 2) { empty++; continue; }
    const query = ph.join("; ");
    ov += overlap(query, r.title || "");
    await out.write({ key: r.key, server: r.server, category: r.category, queries: { extract: query }, phrases: ph, source: "rake-idf" });
    n++;
    if (n % 100000 === 0) log(`  ${n} papers, ${(n / elapsed()).toFixed(0)}/s…`);
  }
  await out.drain(); await out.close();
  log(`queries-extract.jsonl: ${n} papers · ${empty} skipped (no usable abstract) · mean title-overlap ${((ov / n) * 100).toFixed(1)}% · ${human(bytesOf(OUT))}`);
}

const t = Date.now();
if (has("--df")) await buildDf();
if (has("--validate")) await validate();
if (has("--run")) await run();
if (!["--df", "--validate", "--run"].some(has)) console.log("usage: extract-queries.mjs --df | --validate | --run");
log(`done in ${((Date.now() - t) / 1000).toFixed(1)}s`);
