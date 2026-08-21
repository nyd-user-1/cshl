# What Bedrock actually gives us — 2026-08-21

Account 638175140432, us-east-1 unless noted. Everything below was run through the
AWS CLI, and the negative results are as load-bearing as the positive ones.

## Shipped

### 1. A subject agent that retrieves through our own stack

`CshlInfectiousDiseases-5YqcYMkEBo`, an AgentCore harness built to the same shape as
the two from `lane/bedrock-kb` (harness → `cshl-kb-gateway` MCP → Lambda, AWS_IAM
inbound, `claude-haiku-4-5`).

The point of it: the new tool `search_preprints` (Lambda `cshl-kb-subjectsearch`)
calls **the live site's `/api/search` with `server` + `category`**. Retrieval stays
ours — fine-tuned encoder, FTS, RRF, subject-scoped — and Bedrock supplies only the
voice. It also inherits the gateway's existing `check_publication_status` and
`find_related` tools, so one gateway now carries three.

Deploy another: `scripts/kb/deploy-subject-agent.sh "<category>" <server>`.
Invoke: `node scripts/kb/invoke-harness.mjs infectious "<question>"`.

Live test — "What do recent medRxiv preprints say about Bundibugyo ebolavirus
diagnostics?" returned the BDBV RT-qPCR preprint `2026.08.17.26360605` with the
correct assay details plus four related papers, `input=4549 output=359`, **$0.0063**.

Memory is enabled on this harness (the others disable it). That required adding a
`Memory` statement to `cshl-kb-harness-role` — AgentCore auto-creates a memory store
per harness and the role could not `ListEvents` on it, which surfaced as
`Harness is not in an invokable state` → `AccessDeniedException`.

### 2. A grounding score on every answer

Guardrail `1a0cn7441mk6` (contextual grounding, action `NONE` — measurement, not
enforcement), called from `/api/grounding` after an answer finishes, displayed as a
"% grounded" badge in the chat footer.

| answer | grounding |
|---|---|
| claim supported by the abstract | **0.96** |
| true claim, attributed ("McMahon et al. …"), source = bare abstract | 0.17 |
| same claim, source = key + title + **byline** + abstract | **0.89** |
| invented FDA approval and detection limits | **0.00** |

Two findings worth keeping:

- **The grounding source must carry the byline.** Our answers attribute and cite;
  abstracts contain no author names, so a *correct* attribution scored 0.17 as
  unsupported. Adding authors and the key number to the source fixed it (0.89).
- **RELEVANCE is not usable here.** On answers that plainly addressed the question
  asked it returned 0.03–0.53. It is still returned and logged, but the verdict uses
  GROUNDING alone.

## Not adopted, with the reason

- **Prompt routers** exist (`default-prompt-router/anthropic.claude:1`) but route only
  between Claude 3 Haiku and Claude 3.5 Sonnet, and `CreatePromptRouter` rejects
  Claude 4.5 model IDs outright (`Prompt routing is not supported for the specified
  model identifier`). Adopting it would *downgrade* /chat from Haiku 4.5.
- **Bedrock Agents (classic)** is in maintenance mode and closed to accounts without
  prior usage — the reason everything runs on AgentCore.

## Fine-tuning a frontier model on our data: blocked, and here is the evidence

The target was doctrine-correct: customize the model for the **librarian's** job
(assign MeSH headings to an abstract), not for answering. We hold 102,725 labeled
rows from the classifier lane, so the result would have been scoreable head-to-head
against a model we already own. `scripts/kb/build-nova-mesh-ft.mjs` builds the set in
Bedrock's `bedrock-conversation-2024` schema.

**Nova Micro** is the only fine-tunable model in us-east-1 and the only family with
**on-demand** custom deployment (`Nova Micro/Lite/Pro/Nova 2 Lite`; no Claude). Four
jobs, four identical failures:

| job | data | hyper-params | result |
|---|---|---|---|
| `cshl-mesh-librarian-nova-micro-1` | 3,000 rows + validation | epoch 2, lr, batch | Failed — internal error |
| `cshl-mesh-librarian-nova-micro-2` | 3,000 rows | epoch 2 | Failed — internal error |
| `cshl-mesh-tiny-3` | 100 rows | epoch 1 | Failed — internal error |
| `cshl-toy-4` | 40 canonical `1+1=2` rows | epoch 1 | Failed — internal error |

The toy job is the control: a minimal, schema-perfect dataset fails the same way, so
**the blocker is not our data**. Ruled out along the way — S3 region (bucket is
us-east-1), role permissions (Bedrock wrote its `.write_access_check_file.temp` to the
output prefix), and model access (base `amazon.nova-micro-v1:0` invokes fine). The
remaining explanation is service- or account-side enablement, which needs AWS support.

**Claude fine-tuning is trainable but unservable here.** `anthropic.claude-3-haiku`
is customizable in **us-west-2**, but custom Claude models cannot use on-demand
deployment, and this account's Provisioned Throughput quotas are **0.0 model units**
(including no-commitment). Training one would produce an artifact we could not invoke.

**Spend: $0.** Failed customization jobs are not billed; the budget was never touched.

## Next

- Open an AWS support case for Nova customization in this account — the control job
  makes it a two-line report.
- Score the agent's answers with the grounding check as a regression metric, not just
  a badge: it is the first automatic quality number this product has had.
