// scripts/mine/synth-queries.mjs — LLM synthetic query generator (LANE-MINE task 3).
//
//   node --env-file=.env.local scripts/mine/synth-queries.mjs --validate [--n 20]
//   node --env-file=.env.local scripts/mine/synth-queries.mjs --cost [--n 60000]
//   node --env-file=.env.local scripts/mine/synth-queries.mjs --run --n N     # GATED on Brendan
//
// Everything else this lane mines is doc→doc (citations) or doc→label (MeSH,
// category). Retrieval is query→doc, and nothing in the corpus is shaped like a
// query. This closes that gap at 100% coverage — every paper has an abstract.
//
// The whole difficulty is that an LLM asked for "queries about this paper"
// writes paraphrased titles, and a model trained on paraphrased titles learns
// title matching, not retrieval. The prompt below is built against that failure
// mode: four query FAMILIES with different shapes and lengths, an explicit ban
// on lifting the title's noun phrase, and a requirement that at least one query
// be answerable by many papers (so the set is not degenerate 1-to-1).
//
// SPEND: Bedrock, on-demand. --run is gated on Brendan's explicit go; --cost
// prints the estimate from MEASURED token counts, not guesses.

import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { jsonlWriter, existingKeys, psqlRows, log, has, numArg, strArg, human, bytesOf, elapsed, sleep } from "./lib.mjs";
import { writeFileSync } from "node:fs";

const REGION = process.env.BEDROCK_REGION ?? "us-east-1";
const MODEL = strArg("--model", "us.anthropic.claude-haiku-4-5-20251001-v1:0");
const OUT = "data/mine/queries-synth.jsonl";

// Bedrock on-demand $/1M tokens for Claude Haiku 4.5. Overridable so the report
// can be re-costed without editing code if the published rate moves.
const IN_PER_M = numArg("--in-price", 1.0);
const OUT_PER_M = numArg("--out-price", 5.0);

if (!process.env.AWS_BEARER_TOKEN_BEDROCK && process.env.BEDROCK_API_KEY) {
  process.env.AWS_BEARER_TOKEN_BEDROCK = process.env.BEDROCK_API_KEY;
}
const bedrock = new BedrockRuntimeClient({ region: REGION });

const SYSTEM = `You write realistic search queries that a working biomedical researcher would type into a literature search engine, given a paper they would be happy to find.

You are building training data for a retrieval model. The queries must behave like real queries, which means they must NOT be paraphrases of the paper's title. A model trained on title paraphrases learns title matching and fails at retrieval.

For each paper, write exactly 4 queries, one of each family:

1. "keyword" — 3 to 7 words, no punctuation, the way someone types into PubMed. Terminology, not a sentence. e.g. "CRISPR off-target detection liver"
2. "question" — a natural-language question, 8 to 20 words, ending in a question mark. e.g. "Does chronic stress change hippocampal neurogenesis in adult mice?"
3. "method" — asks for the technique, assay, model organism, or analysis rather than the finding. e.g. "single-cell RNA-seq protocol for frozen post-mortem brain tissue"
4. "broad" — a genuinely general query this paper is one good answer among many for. It must NOT uniquely identify this paper. e.g. "mechanisms of antibiotic resistance in gram-negative bacteria"

Hard rules:
- NEVER reuse the title's distinctive noun phrase verbatim. Re-express the concept in the words a searcher would reach for first.
- NEVER refer to "this study", "the authors", "the paper", or "these results". A searcher does not know the paper exists.
- NEVER include the paper's specific numeric results, sample sizes, or p-values.
- Use the vocabulary of the field, including standard abbreviations, exactly as a specialist would type it.
- If the abstract is not in English or is unusable, still produce your best 4 queries from whatever is legible.`;

const TOOL = {
  toolSpec: {
    name: "emit_queries",
    description: "Return the four search queries for this paper.",
    inputSchema: {
      json: {
        type: "object",
        properties: {
          keyword: { type: "string" },
          question: { type: "string" },
          method: { type: "string" },
          broad: { type: "string" },
        },
        required: ["keyword", "question", "method", "broad"],
      },
    },
  },
};

const ABSTRACT_CHARS = numArg("--abstract-chars", 1500);

function userBlock(p) {
  return `Title: ${p.title}\nCategory: ${p.category ?? "n/a"}\n\nAbstract: ${String(p.abstract || "").slice(0, ABSTRACT_CHARS)}`;
}

async function generate(p, tries = 4) {
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const res = await bedrock.send(new ConverseCommand({
        modelId: MODEL,
        system: [{ text: SYSTEM }],
        messages: [{ role: "user", content: [{ text: userBlock(p) }] }],
        toolConfig: { tools: [TOOL], toolChoice: { tool: { name: "emit_queries" } } },
        inferenceConfig: { maxTokens: 500, temperature: 1 },
      }));
      const block = (res.output?.message?.content || []).find((c) => c.toolUse);
      if (!block) throw new Error("no toolUse block");
      return { queries: block.toolUse.input, usage: res.usage };
    } catch (e) {
      const retryable = /Throttl|TooManyRequests|ServiceUnavailable|Timeout|no toolUse/i.test(String(e?.name || e?.message || e));
      if (attempt === tries || !retryable) return { error: String(e?.message || e) };
      await sleep(Math.min(20_000, 800 * 2 ** attempt) + Math.random() * 500);
    }
  }
}

// ── sample papers (read-only) ────────────────────────────────────────────────
async function samplePapers(n, offset = 0) {
  const rows = await psqlRows(
    `SELECT key_number, server, title, categories[1], left(abstract, 4000)
       FROM preprints
      WHERE abstract IS NOT NULL AND length(abstract) > 200
      ORDER BY md5(key_number) OFFSET ${offset} LIMIT ${n};`
  );
  // psql -A -t with \t separators: abstracts contain no tabs, but newlines are
  // re-emitted as literal spaces by the driver, so a row is one line.
  return rows.filter((r) => r.length >= 5).map(([key, server, title, category, abstract]) => ({ key, server, title, category, abstract }));
}

// ── validate: 20 papers, every output printed as evidence ────────────────────
async function validate() {
  const n = numArg("--n", 20);
  const papers = await samplePapers(n);
  log(`validating the prompt on ${papers.length} papers via ${MODEL}`);
  const t0 = Date.now();
  const results = [];
  let inTok = 0, outTok = 0;
  for (const p of papers) {
    const r = await generate(p);
    if (r.error) { log(`  ${p.key}: ERROR ${r.error}`); results.push({ ...p, error: r.error }); continue; }
    inTok += r.usage?.inputTokens ?? 0; outTok += r.usage?.outputTokens ?? 0;
    results.push({ key: p.key, server: p.server, title: p.title, category: p.category, queries: r.queries });
  }
  const secs = (Date.now() - t0) / 1000;

  // The check that matters: does a query just echo the title? Measure the
  // token overlap between each query and the title, and flag the lazy ones.
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 3);
  const STOP = new Set(["with", "from", "that", "this", "were", "have", "been", "using", "into", "their", "which", "these", "than", "also", "more", "such"]);
  let flagged = 0, checked = 0;
  const overlaps = [];
  for (const r of results) {
    if (!r.queries) continue;
    const tw = new Set(norm(r.title).filter((w) => !STOP.has(w)));
    for (const [fam, q] of Object.entries(r.queries)) {
      const qw = norm(q).filter((w) => !STOP.has(w));
      const ov = qw.length ? qw.filter((w) => tw.has(w)).length / qw.length : 0;
      overlaps.push({ key: r.key, fam, ov, q });
      checked++;
      if (ov > 0.8) flagged++;
    }
  }
  overlaps.sort((a, b) => b.ov - a.ov);
  const meanOv = overlaps.reduce((a, x) => a + x.ov, 0) / Math.max(1, overlaps.length);
  const byFam = {};
  for (const o of overlaps) { (byFam[o.fam] ??= []).push(o.ov); }

  log("");
  log(`${results.filter((r) => r.queries).length}/${papers.length} papers produced 4 queries · ${secs.toFixed(1)}s · ${(papers.length / secs).toFixed(2)} papers/s serial`);
  log(`tokens: ${inTok} in / ${outTok} out → ${(inTok / papers.length).toFixed(0)} in + ${(outTok / papers.length).toFixed(0)} out per paper`);
  const cost = (inTok / 1e6) * IN_PER_M + (outTok / 1e6) * OUT_PER_M;
  log(`measured cost for ${papers.length} papers: $${cost.toFixed(5)} → $${((cost / papers.length) * 1000).toFixed(3)} per 1,000 papers`);
  log(`title-overlap (fraction of query content words also in the title): mean ${(meanOv * 100).toFixed(1)}%, ${flagged}/${checked} queries above 80% (title-echo)`);
  for (const [fam, xs] of Object.entries(byFam)) log(`  ${fam.padEnd(9)} mean overlap ${((xs.reduce((a, b) => a + b, 0) / xs.length) * 100).toFixed(1)}%`);
  log(`worst three: ${overlaps.slice(0, 3).map((o) => `${(o.ov * 100).toFixed(0)}% "${o.q}"`).join(" | ")}`);

  writeFileSync("data/mine/raw/synth-validate.json", JSON.stringify({
    model: MODEL, n: papers.length, at: new Date().toISOString(),
    tokens: { in: inTok, out: outTok, perPaperIn: inTok / papers.length, perPaperOut: outTok / papers.length },
    costPer1k: (cost / papers.length) * 1000,
    overlap: { mean: meanOv, flagged, checked, byFamily: Object.fromEntries(Object.entries(byFam).map(([k, v]) => [k, v.reduce((a, b) => a + b, 0) / v.length])) },
    results,
  }, null, 2));
  log(`wrote data/mine/raw/synth-validate.json (all ${results.length} outputs, full text)`);
}

// ── cost: project the full run from the measured per-paper token counts ──────
async function cost() {
  const v = JSON.parse(await import("node:fs").then((m) => m.readFileSync("data/mine/raw/synth-validate.json", "utf8")));
  const perIn = v.tokens.perPaperIn, perOut = v.tokens.perPaperOut;
  log(`basis: ${v.n} measured papers on ${v.model} — ${perIn.toFixed(0)} in + ${perOut.toFixed(0)} out tokens/paper`);
  log(`price: $${IN_PER_M}/1M in, $${OUT_PER_M}/1M out (Bedrock on-demand)`);
  log("");
  log("subsample      in-tokens     out-tokens        cost     wall-clock @16 lanes");
  for (const n of [25_000, 50_000, 100_000, 216_000, 433_000]) {
    const i = perIn * n, o = perOut * n;
    const c = (i / 1e6) * IN_PER_M + (o / 1e6) * OUT_PER_M;
    const secs = n / (16 / (v.secsPerPaper ?? 1.6));
    log(`${String(n).padStart(8)}  ${(i / 1e6).toFixed(1).padStart(9)}M  ${(o / 1e6).toFixed(1).padStart(11)}M  ${("$" + c.toFixed(2)).padStart(10)}   ${(secs / 3600).toFixed(1)}h`);
  }
}

// ── run (GATED) ──────────────────────────────────────────────────────────────
async function run() {
  if (!has("--i-have-brendans-go")) {
    console.log("REFUSED: --run spends money on Bedrock. This lane's HARD CAPS require Brendan's explicit go first.");
    console.log("Show him the --cost table, then rerun with --run --n N --i-have-brendans-go");
    return;
  }
  const n = numArg("--n", 0);
  if (!n) { console.log("--run needs --n (the subsample size Brendan approved)"); return; }
  const papers = await samplePapers(n);
  const done = await existingKeys(OUT, "key");
  const todo = papers.filter((p) => !done.has(p.key));
  log(`synthetic queries: ${papers.length} sampled, ${done.size} already done, ${todo.length} to generate`);

  const out = jsonlWriter(OUT);
  const lanes = numArg("--lanes", 12);
  const queue = [...todo];
  let ok = 0, failed = 0, inTok = 0, outTok = 0, lastLog = 0;
  await Promise.all(Array.from({ length: Math.min(lanes, queue.length) }, async () => {
    while (queue.length) {
      const p = queue.shift();
      const r = await generate(p);
      if (r.error) { failed++; continue; }
      inTok += r.usage?.inputTokens ?? 0; outTok += r.usage?.outputTokens ?? 0;
      await out.write({ key: p.key, server: p.server, category: p.category, queries: r.queries, model: MODEL, source: "bedrock-synth" });
      ok++;
      if (Date.now() - lastLog > 30_000) {
        lastLog = Date.now();
        const spent = (inTok / 1e6) * IN_PER_M + (outTok / 1e6) * OUT_PER_M;
        log(`${ok} done · ${failed} failed · ${queue.length} left · ${(ok / elapsed()).toFixed(1)} papers/s · $${spent.toFixed(2)} spent`);
      }
    }
  }));
  await out.drain(); await out.close();
  const spent = (inTok / 1e6) * IN_PER_M + (outTok / 1e6) * OUT_PER_M;
  log(`queries-synth.jsonl: ${ok} papers × 4 queries = ${ok * 4} queries · ${failed} failed · $${spent.toFixed(2)} · ${human(bytesOf(OUT))}`);
}

const t = Date.now();
if (has("--validate")) await validate();
else if (has("--cost")) await cost();
else if (has("--run")) await run();
else console.log("usage: synth-queries.mjs --validate [--n 20] | --cost | --run --n N --i-have-brendans-go");
log(`done in ${((Date.now() - t) / 1000).toFixed(1)}s`);
