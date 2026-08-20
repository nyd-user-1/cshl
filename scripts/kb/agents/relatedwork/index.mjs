// cshl-kb-relatedwork — "who else has written this paper, and who should review it?"
//
// WHY THIS AGENT EXISTS. `preprint_embeddings_cshl` holds 433,449 vectors from the
// CITE encoder (doc->doc supervision). CSHL-CPT-REPORT names it as still the better
// document->document encoder (R@10 0.2120 vs 0.1980 for the query-shaped model) and
// "the right arm for more-like-this, reviewer matching and systematic-review
// expansion" — and then records that it has NO query-side route in the app. It has
// been dead weight in production since the qpairs flip. This is its route.
//
// It is doc->doc, so there is no query to encode: the probe vector is the input
// paper's OWN stored embedding. That means no encoder round trip, no serve box, and
// no possibility of disturbing whatever checkpoint another lane has loaded on it.
//
// Reviewer mode applies the conflict-of-interest rule that makes the output usable:
// drop any candidate sharing an author surname with the input paper.
import { neon } from '@neondatabase/serverless'

const sql = neon(process.env.DATABASE_URL)
const q = (t, p = []) => sql.query(t, p)

const surnames = (a) => new Set(String(a ?? '').split(';').map((x) => x.trim().split(',')[0].trim().toLowerCase()).filter((s) => s.length > 1))

async function related({ key_number, limit = 8, mode = 'related' }) {
  const src = await q(
    `SELECT p.key_number, p.title, p.authors, e.embedding::text AS v
     FROM preprints p JOIN preprint_embeddings_cshl e USING (key_number)
     WHERE p.key_number = $1`, [key_number])
  if (!src.length) return { error: `no CITE-encoder vector for ${key_number} (is it in the corpus?)` }
  const me = src[0]
  const mine = surnames(me.authors)

  // ef_search must share the transaction with the scan or it lands on a different
  // pooled connection; the probe is a BOUND parameter or HNSW is defeated.
  const [, rows] = await sql.transaction([
    sql.query(`SET LOCAL hnsw.ef_search = 100`),
    sql.query(
      `SELECT p.key_number, p.title, p.authors, p.pub_year, p.published_journal, p.server,
              (1 - (e.embedding <=> $1::vector))::float AS similarity
       FROM preprint_embeddings_cshl e JOIN preprints p USING (key_number)
       WHERE p.key_number <> $2
       ORDER BY e.embedding <=> $1::vector LIMIT $3`,
      [me.v, key_number, Math.min(50, Number(limit) * 4 + 10)]),
  ])

  const out = []
  for (const r of rows) {
    const theirs = surnames(r.authors)
    const shared = [...theirs].filter((s) => mine.has(s))
    if (mode === 'reviewers' && shared.length) continue   // conflict of interest
    out.push({
      key_number: r.key_number,
      title: r.title,
      first_author: String(r.authors ?? '').split(';')[0]?.trim() || null,
      year: r.pub_year,
      journal: r.published_journal,
      server: r.server,
      similarity: Number(r.similarity.toFixed(4)),
      ...(mode === 'reviewers' ? {} : { shared_authors: shared }),
    })
    if (out.length >= Number(limit)) break
  }
  return {
    source: { key_number: me.key_number, title: me.title },
    mode,
    encoder: 'NYSgpt/cshl-encoder-bge-m3 (CITE, doc->doc) via preprint_embeddings_cshl',
    ...(mode === 'reviewers' ? { excluded: 'candidates sharing an author surname with the source paper' } : {}),
    results: out,
  }
}


/* ── invocation-shape shim ──────────────────────────────────────────────────
 * This Lambda is reachable two ways and they disagree about everything.
 *
 *   classic Bedrock Agents action group -> event.parameters is [{name,value}…]
 *       and the reply must be wrapped in {messageVersion, response:{…}}
 *   AgentCore Gateway lambda target     -> the tool input arrives as the EVENT
 *       ITSELF ({title: "…"}) and the reply is the raw result
 *
 * Getting this wrong is silent: the Gateway invoked us four times, we found no
 * event.parameters, threw "title is required" in 1.7ms, and the agent — unable to
 * use its tool — fell back to memory and asserted the wrong journal. A tool that
 * fails closed still produces a confident answer, just not from the tool.
 * Support both, detect by shape, never assume. */
const readParams = (event) => {
  if (Array.isArray(event?.parameters)) return Object.fromEntries(event.parameters.map((p) => [p.name, p.value]))
  if (event && typeof event === 'object' && typeof event.body === 'string') { try { return JSON.parse(event.body) } catch { /* fall through */ } }
  const { actionGroup, messageVersion, function: _fn, sessionAttributes, promptSessionAttributes, agent, inputText, sessionId, ...rest } = event ?? {}
  return rest
}
const isClassic = (event) => !!(event?.messageVersion || event?.actionGroup)
const reply = (event, body) => isClassic(event)
  ? { messageVersion: '1.0', response: { actionGroup: event.actionGroup, function: event.function, functionResponse: { responseBody: { TEXT: { body: JSON.stringify(body) } } } } }
  : body

export const handler = async (event) => {
  console.log('EVENT', JSON.stringify(event).slice(0, 800))
  const p = readParams(event)
  let body
  try {
    if (!p.key_number) throw new Error('key_number is required')
    body = await related({ key_number: p.key_number.trim(), limit: p.limit ?? 8, mode: p.mode ?? 'related' })
  } catch (e) { body = { error: String(e).slice(0, 300) } }
  return reply(event, body)
}
