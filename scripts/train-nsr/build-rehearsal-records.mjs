#!/usr/bin/env node
// LANE-TRAIN Phase 1 prep: LANE-TRIPLETS' negatives.jsonl has no query/positive
// text (just {family,id,negatives}) — pull it here. DB-only, unpooled, light,
// laptop-safe. Reuses LANE-EVAL's flattener/segment/holdout helpers verbatim
// (not re-implemented). Two anchor kinds turned up in the slice, not just KW:
// KW id = nsr.key_number; EX id = an EXFOR exfor_id (LANE-TRIPLETS Phase 1 §1b)
// whose text/positive come from exfor_entries + nsr_exfor, same as LANE-EVAL's
// own EX construction, with a holdout filter so a positive is never a
// held-out paper (LANE-TRAIN non-negotiable #6).
import { neon } from '@neondatabase/serverless'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { flattenGroup, era, richness, reftype, isHeldOut } from '../eval/build-nsr-eval.mjs'

const DIR = join(process.env.HOME, 'Model/nsr-training-pairs/out/rehearsal')
const sql = neon(process.env.DATABASE_URL_UNPOOLED)

const anchors = readFileSync(join(DIR, 'negatives.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
const kwIds = anchors.filter((a) => a.family === 'KW').map((a) => a.id)
const exIds = anchors.filter((a) => a.family === 'EX').map((a) => a.id)
console.log(`anchors: ${anchors.length} (${kwIds.length} KW, ${exIds.length} EX)`)

const kwRows = kwIds.length
  ? await sql.query(`SELECT key_number, sentence_groups, title, abstract, pub_year, reference_type FROM nsr WHERE key_number = ANY($1::text[])`, [kwIds])
  : []
const kwByKey = new Map(kwRows.map((r) => [r.key_number, r]))

const exEntries = exIds.length ? await sql.query(`SELECT exfor_id, title, reactions FROM exfor_entries WHERE exfor_id = ANY($1::text[])`, [exIds]) : []
const exEntryById = new Map(exEntries.map((r) => [r.exfor_id, r]))
const exLinkRows = exIds.length ? await sql.query(`SELECT exfor_id, key_number FROM nsr_exfor WHERE exfor_id = ANY($1::text[])`, [exIds]) : []
const linksById = new Map()
for (const l of exLinkRows) { if (!linksById.has(l.exfor_id)) linksById.set(l.exfor_id, []); linksById.get(l.exfor_id).push(l.key_number) }
const exPosKeys = [...new Set([...linksById.values()].flat().filter((k) => !isHeldOut(k)))]
const exPosRows = exPosKeys.length ? await sql.query(`SELECT key_number, title, abstract, pub_year, reference_type FROM nsr WHERE key_number = ANY($1::text[])`, [exPosKeys]) : []
const exPosByKey = new Map(exPosRows.map((r) => [r.key_number, r]))

const out = []
const dropped = { missingKw: 0, emptyQuery: 0, noExEntry: 0, noEligibleLink: 0 }
for (const a of anchors) {
  if (a.family === 'KW') {
    const row = kwByKey.get(a.id)
    if (!row) { dropped.missingKw++; continue }
    const groups = Array.isArray(row.sentence_groups) ? row.sentence_groups : []
    const query = groups.map(flattenGroup).filter(Boolean).join('\n')
    if (!query) { dropped.emptyQuery++; continue }
    out.push({
      query, positive: { slug: row.key_number, title: row.title, abstract: row.abstract }, negatives: a.negatives,
      meta: { family: 'KW', segment: { era: era(row.pub_year), richness: richness(row.abstract), reftype: reftype(row.reference_type) } },
    })
  } else {
    const entry = exEntryById.get(a.id)
    if (!entry) { dropped.noExEntry++; continue }
    const reactionCodes = Array.isArray(entry.reactions) ? entry.reactions : []
    const query = [entry.title, ...reactionCodes].filter(Boolean).join('; ')
    // Deterministic single positive (sorted first non-held-out link) — keeps
    // one record per anchor id, matching the 1:1 shape of the other family.
    const posKey = (linksById.get(a.id) || []).filter((k) => !isHeldOut(k)).sort()[0]
    const posRow = posKey && exPosByKey.get(posKey)
    if (!query || !posRow) { dropped.noEligibleLink++; continue }
    out.push({
      query, positive: { slug: posRow.key_number, title: posRow.title, abstract: posRow.abstract }, negatives: a.negatives,
      meta: { family: 'EX', segment: { era: era(posRow.pub_year), richness: richness(posRow.abstract), reftype: reftype(posRow.reference_type) } },
    })
  }
}

writeFileSync(join(DIR, 'rehearsal.records.jsonl'), out.map((r) => JSON.stringify(r)).join('\n') + '\n')
console.log(`wrote ${out.length} records; dropped ${JSON.stringify(dropped)}`)
