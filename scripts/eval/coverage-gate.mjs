#!/usr/bin/env node
// coverage-gate.mjs — the assertion that must pass before anything publishes.
//
// WHY THIS EXISTS, in one sentence: a loader validating itself can only prove
// internal consistency, never coverage.
//
// Three bugs on the night of 2026-08-19 all produced something that looked
// right and raised no error. Two are directly relevant here:
//
//   * The embed rig's pass 1 reported "0 uncovered papers." True — relative to
//     the table as it stood. The corpus grew by 228,813 rows afterwards.
//   * The loader reported papers = distinct_keys = distinct (server, doi) =
//     426,352, zero collisions, zero duplicates. Every one of those numbers was
//     true, and the load was still 7,097 papers short, because an early upsert
//     snapshotted a stage table that was still being written.
//
// Both were internally consistent. Both were blind to the same thing. The only
// check that saw it re-derived the count from the source without trusting the
// process that produced it.
//
// So this file never accepts a number from a pass report. Every figure below is
// counted at assertion time, from the tables themselves, and every non-zero
// shortfall must be *explained* by a stated rule rather than merely reported.
//
// Usage:  node scripts/eval/coverage-gate.mjs            # gate the main arm
//         ARMS=medcpt,specter2,scincl node …             # also gate baselines
//         EXPECT_CORPUS=433449 node …                    # assert the denominator too
// Exit 0 = publishable. Exit 1 = do not publish.
import { neon } from '@neondatabase/serverless'
import { readFileSync } from 'node:fs'
import { REGISTRY } from './score.mjs'
import { recipeSql, embeddableSql, CAP } from './recipe.mjs'

for (const l of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = l.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
}
const url = process.env.DATABASE_URL_UNPOOLED
if (!url.replace(/^[^@]+@/, '').startsWith('ep-orange-water-aut2eymf.')) throw new Error('FENCE FAIL')
const sql = neon(url)
const q = (t, p = []) => sql.query(t, p)

const fails = []
const note = (ok, label, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) fails.push(label)
}

// ── the denominator, counted now ─────────────────────────────────────────────
const [{ corpus, embeddable, unembeddable }] = await q(`
  SELECT count(*)::int corpus,
         count(*) FILTER (WHERE ${embeddableSql('preprints')})::int embeddable,
         count(*) FILTER (WHERE NOT (${embeddableSql('preprints')}))::int unembeddable
    FROM preprints`)
console.log(`\ncorpus: ${corpus.toLocaleString()} papers · embeddable ${embeddable.toLocaleString()} · excluded by the <20-non-whitespace-char rule ${unembeddable.toLocaleString()}\n`)

if (process.env.EXPECT_CORPUS) {
  const want = Number(process.env.EXPECT_CORPUS)
  note(corpus === want, `corpus is the expected ${want.toLocaleString()}`,
       corpus === want ? null : `counted ${corpus.toLocaleString()}, short by ${(want - corpus).toLocaleString()}`)
}

// ── per-arm coverage ─────────────────────────────────────────────────────────
const arms = ['bge-m3', ...(process.env.ARMS ?? '').split(',').map((s) => s.trim()).filter(Boolean)]
for (const arm of arms) {
  const spec = REGISTRY[arm]
  if (!spec?.table) { note(false, `arm ${arm} is in the registry`); continue }
  const [r] = await q(`
    SELECT (SELECT count(*) FROM ${spec.table})::int rows,
           (SELECT count(*) FROM preprints p LEFT JOIN ${spec.table} e USING (key_number)
             WHERE e.key_number IS NULL)::int uncovered,
           (SELECT count(*) FROM preprints p LEFT JOIN ${spec.table} e USING (key_number)
             WHERE e.key_number IS NULL AND ${embeddableSql('p')})::int uncovered_embeddable,
           (SELECT count(*) FROM ${spec.table} WHERE vector_dims(embedding) <> ${spec.dim})::int bad_dims,
           (SELECT count(*) FROM ${spec.table} WHERE vector_norm(embedding) = 0)::int zero_vecs`)
  console.log(`\narm ${arm} (${spec.table}, dim ${spec.dim}, metric ${spec.metric})`)
  note(r.uncovered_embeddable === 0, `  every embeddable paper has a vector`,
       `${r.rows.toLocaleString()} vectors; ${r.uncovered.toLocaleString()} papers without one, of which ${r.uncovered_embeddable.toLocaleString()} are embeddable`)
  note(r.rows + r.uncovered === corpus, `  vectors + uncovered = corpus`,
       `${r.rows.toLocaleString()} + ${r.uncovered.toLocaleString()} = ${(r.rows + r.uncovered).toLocaleString()} vs ${corpus.toLocaleString()}`)
  note(r.bad_dims === 0, `  all vectors are dim ${spec.dim}`, `${r.bad_dims} wrong`)
  note(r.zero_vecs === 0, `  no zero vectors`, `${r.zero_vecs} found`)
}

// ── the text the encoder actually saw, across the WHOLE corpus ───────────────
// Only meaningful for the main arm: the baselines use their own caps.
const [{ mismatches }] = await q(`
  SELECT count(*)::int mismatches
    FROM preprint_embeddings e JOIN preprints p USING (key_number)
   WHERE e.text_hash <> md5(${recipeSql('p', CAP)})`)
note(mismatches === 0, `text_hash equals md5 of the canonical recipe, corpus-wide`,
     `${mismatches} mismatches (cap ${CAP})`)

console.log(fails.length ? `\nGATE FAILED (${fails.length}): ${fails.join(' | ')}\n` : '\nGATE PASSED — publishable.\n')
process.exit(fails.length ? 1 : 0)
