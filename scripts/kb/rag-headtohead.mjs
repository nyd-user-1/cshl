#!/usr/bin/env node
// rag-headtohead.mjs — the qualitative half of the bake-off, on the case in hand.
//
// The retrieval scorers answer "which documents come back". This answers the
// other question, which the Vink case proved is separate: given documents, what
// gets written. /chat retrieved the right paper and still asserted, in bold, that
// it had not been peer reviewed, and described three findings from a part of the
// abstract it was never shown.
//
// Three arms, same question, same generator (Haiku 4.5):
//   aws-default  RetrieveAndGenerate, stock managed prompt
//   aws-custom   RetrieveAndGenerate with a promptTemplate carrying our own
//                grounding rules — the knob the AWS blog post is about
//   ours-prod    the live https://cshl.nysgpt.com/api/chat
//
// ASYMMETRY, STATED: ours searches all 433,449 documents, the KB searches the
// 10k slice. That favours OURS — a bigger haystack is more likely to contain the
// right paper. It is left in because the point here is product-vs-product on a
// real question, and the retrieval scorers already give the controlled number.
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const exec = promisify(execFile)

const REGION = process.env.AWS_REGION ?? 'us-east-1'
const ACCT = '638175140432'
const KB_ID = readFileSync('scripts/kb/.state/kb_id', 'utf8').trim()
const MODEL = 'us.anthropic.claude-haiku-4-5-20251001-v1:0'
const MODEL_ARN = `arn:aws:bedrock:${REGION}:${ACCT}:inference-profile/${MODEL}`
const N = Number(process.env.NRESULTS ?? 14)   // match /chat's 14-record context budget

const QUESTION = process.env.QUESTION ??
  'Tell me about "Comprehensive PAM prediction for CRISPR-Cas systems reveals evidence for spacer sharing, preferred strand targeting and conserved links with CRISPR repeats" by Vink, J. N.; Baijens, J. H.; Brouns, S. J.. What is the significance of this research?'

// The managed prompt template. $search_results$ and $output_format_instructions$
// are the required placeholders; everything else is ours. These are the same
// grounding rules /chat's system prompt should carry and mostly does not.
const CUSTOM_PROMPT = `You are RxivGPT, a research assistant over the bioRxiv and medRxiv preprint corpora.

Here are the retrieved preprints:
$search_results$

Rules:
- Ground every claim in the retrieved text above. Do not describe a finding you were not shown.
- If you were given only part of an abstract, say what you were given and do not present the rest of the paper's findings as though you read them.
- These are preprints and most are not peer reviewed. State publication status ONLY if the retrieved record shows it. If the record does not say, say the status is unknown — never assert that a paper has not been published.
- Cite papers by their bioRxiv/medRxiv key number.
- Never fabricate key numbers, DOIs, journals or author names.

$output_format_instructions$`

async function rag(mode) {
  const cfg = {
    input: { text: QUESTION },
    retrieveAndGenerateConfiguration: {
      type: 'KNOWLEDGE_BASE',
      knowledgeBaseConfiguration: {
        knowledgeBaseId: KB_ID,
        modelArn: MODEL_ARN,
        retrievalConfiguration: { vectorSearchConfiguration: { numberOfResults: N } },
        ...(mode === 'custom'
          ? { generationConfiguration: { promptTemplate: { textPromptTemplate: CUSTOM_PROMPT } } }
          : {}),
      },
    },
  }
  const t0 = Date.now()
  const { stdout } = await exec('aws', ['bedrock-agent-runtime', 'retrieve-and-generate', '--region', REGION,
    '--cli-input-json', JSON.stringify(cfg), '--output', 'json'], { maxBuffer: 64 * 1024 * 1024 })
  const out = JSON.parse(stdout)
  const cited = new Set()
  for (const c of out.citations ?? [])
    for (const r of c.retrievedReferences ?? [])
      if (r.metadata?.key_number) cited.add(String(r.metadata.key_number))
  return { arm: `aws-${mode}`, ms: Date.now() - t0, text: out.output?.text ?? '', cited: [...cited] }
}

async function ours() {
  const t0 = Date.now()
  const r = await fetch('https://cshl.nysgpt.com/api/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userMessage: QUESTION, messages: [] }),
  })
  const raw = await r.text()
  let text = ''; let cited = []
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data: ')) continue
    const d = line.slice(6); if (d === '[DONE]') continue
    try {
      const j = JSON.parse(d)
      if (j.sources) cited = (j.sources.nsr ?? []).map((x) => x.key_number)
      const t = j.choices?.[0]?.delta?.content
      if (t) text += t
    } catch { /* skip */ }
  }
  return { arm: 'ours-prod', ms: Date.now() - t0, text, cited }
}

const results = []
for (const m of ['default', 'custom']) { try { results.push(await rag(m)) } catch (e) { results.push({ arm: `aws-${m}`, error: String(e).slice(0, 300) }) } }
try { results.push(await ours()) } catch (e) { results.push({ arm: 'ours-prod', error: String(e).slice(0, 300) }) }

mkdirSync('data/kb-slice/results', { recursive: true })
writeFileSync('data/kb-slice/results/headtohead.json', JSON.stringify({ question: QUESTION, n_results: N, results }, null, 1))

// Automated checks on the claims we already established the ground truth for.
const CHECKS = [
  { name: 'cites the Vink key number', re: /2021\.05\.04\.442622/ },
  { name: 'ASSERTS not-peer-reviewed (WRONG - Genome Biology 2021-09-30)', re: /(not\s+(yet\s+)?(been\s+)?(undergone\s+)?(peer[- ]?review\w*|published)|remains? a\s+\*{0,2}preprint|has not appeared in)/i, bad: true },
  { name: 'names Genome Biology (correct)', re: /genome biology/i },
  { name: 'gives strand direction by subtype (template vs coding)', re: /(template strand|coding strand)/i },
  { name: 'names the >100 PAM catalogue', re: /(hundred|100\+|catalog(ue)? of .{0,20}PAM)/i },
  { name: 'array orientation result', re: /orient/i },
]
console.log(`\nQ: ${QUESTION.slice(0, 90)}…\n`)
for (const r of results) {
  if (r.error) { console.log(`${r.arm}: ERROR ${r.error}`); continue }
  console.log(`── ${r.arm}  (${(r.ms / 1000).toFixed(1)}s, ${r.text.length} chars, ${r.cited.length} cited)`)
  for (const c of CHECKS) {
    const hit = c.re.test(r.text)
    const mark = c.bad ? (hit ? 'FAIL' : 'ok  ') : (hit ? 'ok  ' : 'miss')
    console.log(`   ${mark}  ${c.name}`)
  }
}
console.log('\nfull texts -> data/kb-slice/results/headtohead.json')
