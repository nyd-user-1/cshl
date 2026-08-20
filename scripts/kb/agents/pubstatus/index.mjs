// cshl-kb-pubstatus — "has this preprint actually been peer reviewed?"
//
// WHY THIS AGENT EXISTS. On 2026-08-20 /chat asserted, in bold, that Vink et al.
// 2021.05.04.442622 "remains a preprint and has not yet been published in
// peer-reviewed literature" and then built a whole Limitations section on that
// premise. It was published in Genome Biology on 2021-09-30. Our row said
// published_journal = NULL and the model was faithful to the row.
//
// The reason we missed it is the reason this tool does not use the DOI relation:
// bioRxiv's published-DOI link is absent when the TITLE CHANGES on acceptance,
// which is exactly what happened here ("Comprehensive PAM prediction…" became
// "PAM-repeat associations…"). So the match is by BIBLIOGRAPHIC QUERY over title
// + author surnames, and a candidate only counts as the published version when
// the author surnames agree. Title similarity alone would happily match a review
// article about the same subject.
//
// published_journal is NULL on 50.3% of our 433,449 rows, so this is a corpus-wide
// gap, not one bad record.

const CROSSREF = 'https://api.crossref.org/works'
const MAILTO = process.env.CROSSREF_MAILTO ?? 'brendan@nysgpt.com'

const surnames = (authors) =>
  String(authors ?? '').split(';').map((a) => a.trim().split(',')[0].trim().toLowerCase()).filter((s) => s.length > 1)

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()

/** Jaccard over token sets — cheap, and we only need "is this plausibly the same work". */
function titleOverlap(a, b) {
  const A = new Set(norm(a).split(' ').filter((w) => w.length > 3))
  const B = new Set(norm(b).split(' ').filter((w) => w.length > 3))
  if (!A.size || !B.size) return 0
  let hit = 0
  for (const w of A) if (B.has(w)) hit++
  return hit / Math.min(A.size, B.size)
}

async function crossref(params) {
  const u = new URL(CROSSREF)
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v)
  u.searchParams.set('mailto', MAILTO)
  const r = await fetch(u, { headers: { 'User-Agent': `cshl-pubstatus/1.0 (mailto:${MAILTO})` } })
  if (!r.ok) throw new Error(`crossref ${r.status}`)
  return (await r.json()).message?.items ?? []
}

async function resolve({ title, authors, doi }) {
  const items = await crossref({
    'query.bibliographic': `${title} ${surnames(authors).slice(0, 4).join(' ')}`.slice(0, 500),
    rows: '8',
    select: 'DOI,title,container-title,published,author,type',
  })
  const want = new Set(surnames(authors))
  const preprintDoi = String(doi ?? '').toLowerCase()
  const cands = []
  for (const it of items) {
    if (it.type !== 'journal-article') continue
    if (String(it.DOI ?? '').toLowerCase() === preprintDoi) continue
    const fams = (it.author ?? []).map((a) => String(a.family ?? '').toLowerCase()).filter(Boolean)
    const shared = fams.filter((f) => want.has(f)).length
    const overlap = titleOverlap(title, (it.title ?? [''])[0])
    // Author agreement is the gate; title overlap only ranks. A retitled paper by
    // the same three authors is the case we exist for; a same-title paper by other
    // authors is the case we must refuse.
    const authorOk = want.size === 0 ? false : shared >= Math.min(2, want.size)
    if (!authorOk) continue
    cands.push({
      doi: it.DOI,
      journal: (it['container-title'] ?? [''])[0] || null,
      title: (it.title ?? [''])[0] || null,
      date: (it.published?.['date-parts']?.[0] ?? []).join('-'),
      shared_authors: shared,
      title_overlap: Number(overlap.toFixed(2)),
    })
  }
  cands.sort((a, b) => (b.shared_authors - a.shared_authors) || (b.title_overlap - a.title_overlap))
  return cands
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
  const params = readParams(event)
  let body
  try {
    const title = params.title
    if (!title) throw new Error('title is required')
    const cands = await resolve({ title, authors: params.authors, doi: params.doi })
    const best = cands[0]
    body = best
      ? {
          published: true,
          journal: best.journal,
          published_doi: best.doi,
          published_date: best.date,
          published_title: best.title,
          retitled: (best.title_overlap ?? 1) < 0.8,
          evidence: `matched on ${best.shared_authors} shared author surnames, title overlap ${best.title_overlap}`,
          all_candidates: cands.slice(0, 3),
        }
      : {
          published: false,
          note: 'No journal article found in Crossref sharing >=2 author surnames with this preprint. Treat as not-yet-peer-reviewed, but say the check was inconclusive rather than asserting it is unpublished.',
        }
  } catch (e) {
    body = { error: String(e).slice(0, 300) }
  }
  return reply(event, body)
}
