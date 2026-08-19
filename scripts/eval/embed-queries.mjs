#!/usr/bin/env node
// embed-queries.mjs — embed the frozen benchmark's queries for one arm.
// Ported from scripts/eval/embed-queries-worker.mjs + embed-commercial-worker.mjs
// at 8c1b05b, which were two near-identical scripts for two hardcoded providers.
//
// CHANGED vs the NSR originals:
//   - one script, three providers (cloudflare | tei | hf), selected by PROVIDER
//     or inferred from the arm. Adding a baseline's query side is a flag.
//   - output is data/eval/<version>/qemb/<arm>.jsonl, not a DB column — see the
//     header of score.mjs for why.
//   - resumable: an existing qemb file is read first and only missing qids are
//     embedded, so a killed run costs the tail, not the run.
//
// Usage:
//   ARM=bge-m3 node scripts/eval/embed-queries.mjs                       # FREE (Cloudflare)
//   ARM=medcpt PROVIDER=tei TEI_URL=http://<ip>:8080 node …/embed-queries.mjs
//   ARM=specter2 PROVIDER=hf node …/embed-queries.mjs                    # HF router, needs HF_TOKEN
import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { REGISTRY } from './score.mjs'

for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
}

const VERSION = process.env.EVAL_VERSION ?? 'rxiv-eval-v1'
const ARM = process.env.ARM ?? 'bge-m3'
const ROOT = join(process.cwd(), 'data/eval', VERSION)
const QEMB = join(ROOT, 'qemb')
mkdirSync(QEMB, { recursive: true })
const OUTF = join(QEMB, `${ARM}.jsonl`)
const spec = REGISTRY[ARM]
if (!spec || spec.kind !== 'dense') throw new Error(`ARM=${ARM} is not a dense arm in the registry`)
const PROVIDER = process.env.PROVIDER ?? (ARM === 'bge-m3' ? 'cloudflare' : process.env.TEI_URL ? 'tei' : 'hf')
const BATCH = Number(process.env.BATCH ?? (PROVIDER === 'cloudflare' ? 10 : 32))
console.log(`arm=${ARM} provider=${PROVIDER} query_model=${spec.query} dim=${spec.dim} metric=${spec.metric ?? 'cosine'} -> ${OUTF}`)

const providers = {
  async cloudflare(texts) {
    const { CF_ACCOUNT_ID, CF_AI_TOKEN } = process.env
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/@cf/baai/bge-m3`, {
      method: 'POST', headers: { Authorization: `Bearer ${CF_AI_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: texts }),
    })
    const j = await r.json()
    if (!r.ok || !j.success) throw new Error(`cloudflare ${r.status} ${JSON.stringify(j.errors ?? '').slice(0, 200)}`)
    return j.result.data
  },
  async tei(texts) {
    const key = process.env.NSR_SERVE_KEY ?? process.env.HF_TOKEN ?? ''
    const r = await fetch(`${process.env.TEI_URL.replace(/\/$/, '')}/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ inputs: texts, truncate: true, normalize: (spec.metric ?? 'cosine') === 'cosine' }),
    })
    if (!r.ok) throw new Error(`tei ${r.status}: ${(await r.text()).slice(0, 200)}`)
    return r.json()
  },
  async hf(texts) {
    const r = await fetch(`https://router.huggingface.co/hf-inference/models/${spec.query}/pipeline/feature-extraction`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.HF_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ inputs: texts, options: { wait_for_model: true } }),
    })
    if (!r.ok) throw new Error(`hf ${r.status}: ${(await r.text()).slice(0, 200)}`)
    const j = await r.json()
    // hf-inference returns token-level vectors for some models; mean-pool if 3-D.
    return j.map((v) => (Array.isArray(v[0]) ? v[0].map((_, i) => v.reduce((s, t) => s + t[i], 0) / v.length) : v))
  },
}

const queries = readFileSync(join(ROOT, 'queries.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const have = new Set()
if (existsSync(OUTF)) for (const l of readFileSync(OUTF, 'utf8').split('\n').filter(Boolean)) have.add(JSON.parse(l).qid)
const todo = queries.filter((q) => !have.has(q.qid))
console.log(`${queries.length} queries, ${have.size} already embedded, ${todo.length} to go`)

let n = 0, dimSeen = null
const t0 = Date.now()
for (let i = 0; i < todo.length; i += BATCH) {
  const slice = todo.slice(i, i + BATCH)
  let vecs
  try {
    vecs = await providers[PROVIDER](slice.map((q) => q.text.slice(0, Number(process.env.QCAP ?? 2000))))
  } catch (e) {
    console.error(`batch @${i} failed (${e.message}) — retrying per-item`)
    vecs = []
    for (const q of slice) {
      try { vecs.push((await providers[PROVIDER]([q.text.slice(0, 2000)]))[0]) }
      catch (e2) { console.error(`  skip ${q.qid}: ${e2.message}`); vecs.push(null) }
    }
  }
  const lines = []
  slice.forEach((q, j) => {
    const v = vecs[j]
    if (!Array.isArray(v)) return
    dimSeen ??= v.length
    if (v.length !== spec.dim) throw new Error(`arm ${ARM}: expected dim ${spec.dim}, got ${v.length} — registry and model disagree`)
    lines.push(JSON.stringify({ qid: q.qid, v: v.map((x) => +x.toFixed(6)) }))
    n++
  })
  if (lines.length) appendFileSync(OUTF, lines.join('\n') + '\n')
  if (i % (BATCH * 20) === 0) console.log(`  ${n}/${todo.length} (${(n / ((Date.now() - t0) / 1000)).toFixed(1)}/s)`)
}
console.log(`done: ${n} query vectors (dim ${dimSeen}) in ${((Date.now() - t0) / 1000).toFixed(1)}s -> ${OUTF}`)
