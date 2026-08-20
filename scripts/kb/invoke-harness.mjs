#!/usr/bin/env node
// invoke-harness.mjs — call a CSHL AgentCore harness and print transcript + cost.
//
// ⚠ SPENDS MONEY (Bedrock tokens). Every run prints its own token counts and an
// estimated cost so the spend is on the record rather than reconstructed later.
//
// InvokeHarness is a data-plane operation aws-cli 2.36.5 does not expose, so this
// shells out to a boto3 venv — the same pattern 44b's invoke-agent.mjs uses.
//   python3 -m venv /tmp/cshl-kb-venv && /tmp/cshl-kb-venv/bin/pip install boto3
//
//   node scripts/kb/invoke-harness.mjs pubstatus "Has <paper> been peer reviewed?"
//   node scripts/kb/invoke-harness.mjs related   "Related work for 2021.05.04.442622"
import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REGION = process.env.AWS_REGION ?? 'us-east-1'
const ACCT = '638175140432'
const NAMES = { pubstatus: 'CshlPubStatusClerk', related: 'CshlRelatedWork' }
const PRICE_IN = 1.0, PRICE_OUT = 5.0   // Haiku 4.5 on-demand, USD / 1M tokens

const [, , which, ...rest] = process.argv
const prompt = rest.join(' ')
if (!NAMES[which] || !prompt) { console.error('usage: invoke-harness.mjs <pubstatus|related> "<prompt>"'); process.exit(2) }

const ids = JSON.parse(execFileSync('aws', ['bedrock-agentcore-control', 'list-harnesses', '--region', REGION, '--output', 'json'], { encoding: 'utf8' })).harnesses
const h = ids.find((x) => x.harnessName === NAMES[which])
if (!h) { console.error(`harness ${NAMES[which]} not found`); process.exit(1) }
const arn = `arn:aws:bedrock-agentcore:${REGION}:${ACCT}:harness/${h.harnessId}`

const venv = process.env.AGENTCORE_VENV ?? '/tmp/cshl-kb-venv'
const python = join(venv, 'bin', 'python')
if (!existsSync(python)) { console.error(`no boto3 venv at ${python}`); process.exit(2) }

const session = `${which}-${Date.now()}`.padEnd(33, '0')
const driver = `
import json, sys, boto3
arn, sid, prompt = sys.argv[1], sys.argv[2], sys.argv[3]
c = boto3.client("bedrock-agentcore", region_name="${REGION}")
r = c.invoke_harness(harnessArn=arn, runtimeSessionId=sid, messages=[{"role":"user","content":[{"text":prompt}]}])
for event in r["stream"]:
    for k, v in event.items():
        print(json.dumps({"event": k, "data": v}, default=str), flush=True)
`
const scratch = mkdtempSync(join(tmpdir(), 'cshl-agentcore-'))
const dp = join(scratch, 'invoke.py'); writeFileSync(dp, driver)
let raw
try { raw = execFileSync(python, [dp, arn, session, prompt], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }) }
catch (e) { console.error(e.stderr?.toString() ?? e.message); process.exit(1) }

let text = ''; let usage = null; const tools = []
for (const line of raw.split('\n').filter(Boolean)) {
  let f; try { f = JSON.parse(line) } catch { continue }
  const d = f.data ?? {}
  const delta = d.delta?.text ?? d.contentBlockDelta?.delta?.text
  if (typeof delta === 'string') text += delta
  else if (typeof d.text === 'string') text += d.text
  const name = d.name ?? d.toolUse?.name
  if (name && /tool/i.test(f.event)) tools.push(name)
  if (d.usage) usage = d.usage
  if (d.metadata?.usage) usage = d.metadata.usage
}
console.log(`harness: ${NAMES[which]} (${h.harnessId})`)
console.log(`tools called: ${tools.length ? [...new Set(tools)].join(', ') : '(none)'}\n`)
console.log(text.trim() || '(no text — raw frames follow)\n' + raw.slice(0, 1500))
if (usage) {
  const i = usage.inputTokens ?? usage.input_tokens ?? 0, o = usage.outputTokens ?? usage.output_tokens ?? 0
  console.log(`\nusage: input=${i} output=${o} est_cost=$${((i / 1e6) * PRICE_IN + (o / 1e6) * PRICE_OUT).toFixed(4)}`)
}
writeFileSync(`data/kb-slice/agent-${which}-last.json`, JSON.stringify({ prompt, arn, tools, text, usage }, null, 1))
