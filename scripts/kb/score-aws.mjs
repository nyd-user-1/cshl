#!/usr/bin/env node
// score-aws.mjs — score the managed Bedrock KB on the SAME closed-world slice,
// with the SAME queries, qrels and metrics as score-ours.mjs.
//
// Two things make this a fair comparison rather than a demo:
//
//  1. CHUNK -> DOCUMENT DEDUPE. The KB chunks at 300 tokens, so a top-10 list of
//     chunks can contain 10 chunks of 4 papers. Our arms return one vector per
//     document. Asking for 10 chunks and calling it R@10 would penalise AWS for
//     its own chunking. So we ask for POOL (default 100) chunks, collapse to
//     unique documents preserving rank, and take the first 10 documents. Both
//     sides are then answering "did the gold paper make your top-10 PAPERS".
//
//  2. The document id comes from the metadata attribute we wrote at export time,
//     not from parsing the S3 key — the key is a sanitised filename and would
//     silently mismatch on any key_number containing a character we replaced.
//
// Env: MODE=semantic|hybrid|rerank, POOL=100, CONC=4, LIMIT=<n queries>
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const exec = promisify(execFile)

const REGION = process.env.AWS_REGION ?? 'us-east-1'
const KB_ID = process.env.KB_ID ?? readFileSync('scripts/kb/.state/kb_id', 'utf8').trim()
const MODE = process.env.MODE ?? 'semantic'
const POOL = Number(process.env.POOL ?? 100)
const CONC = Number(process.env.CONC ?? 4)

let QUERIES = readFileSync('data/kb-slice/queries.jsonl', 'utf8').split('\n').filter(Boolean).map(JSON.parse)
if (process.env.LIMIT) QUERIES = QUERIES.slice(0, Number(process.env.LIMIT))
const QRELS = new Map()
for (const l of readFileSync('data/kb-slice/qrels.tsv', 'utf8').split('\n').filter(Boolean)) {
  const [qid, k] = l.split('\t')
  if (!QRELS.has(qid)) QRELS.set(qid, new Set())
  QRELS.get(qid).add(k)
}

function retrievalConfig() {
  const vsc = { numberOfResults: POOL }
  if (MODE === 'hybrid') vsc.overrideSearchType = 'HYBRID'
  if (MODE === 'rerank') {
    // The managed analogue of our cshl-RR: a cross-encoder over the candidate
    // pool. Retrieve a wider pool, let Bedrock's reranker reorder it.
    vsc.rerankingConfiguration = {
      type: 'BEDROCK_RERANKING_MODEL',
      bedrockRerankingConfiguration: {
        numberOfRerankedResults: Math.min(POOL, 100),
        modelConfiguration: { modelArn: `arn:aws:bedrock:${REGION}::foundation-model/amazon.rerank-v1:0` },
      },
    }
  }
  return { vectorSearchConfiguration: vsc }
}

async function retrieve(text) {
  const payload = JSON.stringify({
    knowledgeBaseId: KB_ID,
    retrievalQuery: { text: text.slice(0, 1000) },
    retrievalConfiguration: retrievalConfig(),
  })
  const { stdout } = await exec('aws', [
    'bedrock-agent-runtime', 'retrieve', '--region', REGION, '--cli-input-json', payload, '--output', 'json',
  ], { maxBuffer: 64 * 1024 * 1024 })
  const out = JSON.parse(stdout)
  const seen = new Set(); const docs = []
  for (const r of out.retrievalResults ?? []) {
    const k = r.metadata?.key_number ?? r.location?.s3Location?.uri?.split('/').pop()?.replace(/\.txt$/, '')
    if (!k || seen.has(k)) continue
    seen.add(k); docs.push(String(k))
  }
  return docs
}

async function pool(items, conc, fn) {
  const out = new Array(items.length); let i = 0; let done = 0
  await Promise.all(Array.from({ length: conc }, async () => {
    for (;;) {
      const idx = i++; if (idx >= items.length) return
      try { out[idx] = await fn(items[idx], idx) } catch (e) { out[idx] = [items[idx].qid, [], String(e).slice(0, 120)] }
      if (++done % 25 === 0) process.stdout.write(`\r  ${done}/${items.length}`)
    }
  }))
  return out
}

function metrics(ranked, pos) {
  let first = Infinity
  for (let i = 0; i < ranked.length; i++) if (pos.has(ranked[i])) { first = i + 1; break }
  const rAt = (k) => (ranked.slice(0, k).some((id) => pos.has(id)) ? 1 : 0)
  const ideal = Math.min(pos.size, 10)
  const idcg = Array.from({ length: ideal }, (_, i) => 1 / Math.log2(i + 2)).reduce((a, b) => a + b, 0)
  const dcg = ranked.slice(0, 10).reduce((s, id, i) => s + (pos.has(id) ? 1 / Math.log2(i + 2) : 0), 0)
  return { r1: rAt(1), r5: rAt(5), r10: rAt(10), r50: rAt(50), mrr: Number.isFinite(first) ? 1 / first : 0, ndcg10: idcg ? dcg / idcg : 0 }
}

const t0 = Date.now()
console.log(`AWS KB ${KB_ID} mode=${MODE} pool=${POOL} queries=${QUERIES.length}`)
const res = await pool(QUERIES, CONC, async (qq) => [qq.qid, await retrieve(qq.text)])
const ranked = new Map(res.map((r) => [r[0], r[1]]))
const errs = res.filter((r) => r[2]).length
const acc = {}
for (const qq of QUERIES) {
  const m = metrics(ranked.get(qq.qid) ?? [], QRELS.get(qq.qid))
  for (const seg of ['blended', qq.family]) {
    acc[seg] ??= { n: 0, r1: 0, r5: 0, r10: 0, r50: 0, mrr: 0, ndcg10: 0 }
    acc[seg].n++
    for (const k of ['r1', 'r5', 'r10', 'r50', 'mrr', 'ndcg10']) acc[seg][k] += m[k]
  }
}
for (const seg of Object.keys(acc)) for (const k of ['r1', 'r5', 'r10', 'r50', 'mrr', 'ndcg10'])
  acc[seg][k] = Number((acc[seg][k] / acc[seg].n).toFixed(4))
mkdirSync('data/kb-slice/results', { recursive: true })
writeFileSync(`data/kb-slice/results/aws-${MODE}.json`, JSON.stringify({ mode: MODE, pool: POOL, kb: KB_ID, errors: errs, segments: acc, perQuery: Object.fromEntries(ranked) }, null, 1))
console.log(`\naws-${MODE}  MESH R@10 ${acc.MESH?.r10} | AUTHORKW R@10 ${acc.AUTHORKW?.r10} | blended ${acc.blended.r10} | errors ${errs} | ${((Date.now() - t0) / 1000).toFixed(0)}s`)
