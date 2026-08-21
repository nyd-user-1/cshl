# Managed RAG vs ours — Bedrock Knowledge Base against the CSHL stack

**Run 2026-08-20, branch `lane/bedrock-kb`, account 638175140432, us-east-1.**
Everything below is measured on this account today; nothing is quoted from a vendor page.

## The question

/chat runs retrieval we built and paid to train. Amazon will do retrieval for us as a
managed service. Which is better, and at what?

## What was stood up

| piece | choice | why |
|---|---|---|
| Knowledge Base | `cshl-kb-slice` (`MMXHXLS4BN`) | managed, S3 data source |
| Vector store | **S3 Vectors** (`cshl-kb-vectors/cshl-kb-slice-10k`, 1024-d cosine) | OpenSearch Serverless — the console's quick-create default — bills a ~2-OCU floor, about **$11.50/day while idle**. It would have eaten the whole authorised budget without answering a query. S3 Vectors has no idle floor. |
| Embedder | `amazon.titan-embed-text-v2:0`, 1024-d | matches our own dimensionality and metric |
| Chunking | managed default, FIXED_SIZE 300 tokens / 20% overlap | the point is what the product does out of the box |
| Corpus | 10,000 documents, `title\n\nabstract` | the same text our encoders were trained and embedded on |
| Generator | `claude-haiku-4-5` both sides | same generator, so differences are retrieval and prompt, not model |

Ingestion: 10,000 documents, **0 failed**, ~45 min.

## The slice, and why it is a closed world

Retrieval difficulty scales with haystack size. Our published numbers are measured against
all 433,449 documents; a 10k KB is a 43× easier problem. Scoring the managed service on 10k
and comparing to 433k numbers would have handed it a margin it did not earn.

So the slice is a **closed world both systems must search**: the gold documents for 300
queries from the frozen `cshl-eval-2k` benchmark (150 MeSH + 150 AUTHORKW), plus a
deterministic md5-ordered fill to 10,000. `score-ours.mjs` re-runs our arms with
`WHERE key_number = ANY($slice)`. Neither side can retrieve what the other cannot see.

### How big the effect actually is — decomposed

The first version of this section said "0.4319 -> 0.8267" and credited the whole
0.3948 to the slice. That was sloppy: 0.4319 is the report's number over **1,241**
MeSH queries, and 0.8267 is this run's over **150**. Two variables moved, not one.

Re-running the identical 300 queries against the full 433,449-document corpus
(`NO_SLICE=1 node scripts/kb/score-ours.mjs`) separates them:

| MeSH R@10 | published (1,241 q, full corpus) | these 150 q, full corpus | these 150 q, 10k slice |
|---|---:|---:|---:|
| `cshl_qp` | 0.4319 | 0.4800 | **0.8267** |
| `cshl_qp2` | 0.5238 | 0.5600 | **0.9000** |
| stock `bge-m3` | 0.2861 | 0.3133 | **0.6733** |

So for the serving arm: **+0.0481 is a slightly easier query subsample, +0.3467 is
the slice.** The slice is 88% of the gap, not 100%. The bias is small, consistent
across all three arms (+0.027 to +0.048), and therefore a property of the 150
queries rather than of any encoder.

**None of it touches the AWS comparison.** Every arm in the results table answered
the same 300 queries over the same 10,000 documents, so the subsample bias is
common-mode and cancels in the paired tests. It matters only if someone quotes an
absolute number from this page as a full-corpus figure. Do not.

Relative margins also survive the change of scale, which is the real licence for
using a slice at all: `cshl_qp2` - `bge-m3` is +0.2467 on the full corpus and
+0.2267 on the slice; `cshl_qp` - `bge-m3` is +0.1667 and +0.1533.

## Result 1 — retrieval (300 queries, closed slice, R@10 after chunk→document dedupe)

| arm | MeSH R@10 | AUTHORKW R@10 | blended |
|---|---:|---:|---:|
| **`cshl_qp2`** — our best encoder, unserved, NO reranker | **0.9000** | 0.9733 | **0.9367** |
| **`cshl_qp`** — what /chat serves today, NO reranker | **0.8267** | **0.9800** | 0.9033 |
| **AWS managed KB + Cohere Rerank 3.5** — their full stack | 0.7800 | **0.9800** | 0.8800 |
| **AWS managed KB** (Titan v2, semantic only) | 0.7133 | 0.9467 | 0.8300 |
| stock `bge-m3` | 0.6733 | 0.9400 | 0.8067 |
| `medcpt` | 0.6067 | 0.9000 | 0.7533 |
| our FTS arm | 0.1067 | 0.2400 | 0.1733 |

Paired McNemar on the discordant queries (both arms answered the identical 300):

| comparison | MeSH Δ | discordant | *p* |
|---|---:|---:|---:|
| **vs AWS out of the box (semantic only)** | | | |
| `cshl_qp` (serving) vs AWS | **+0.1133** | 21/4 | **9.1e-4** |
| `cshl_qp2` (best) vs AWS | **+0.1867** | 29/1 | **5.8e-8** |
| stock `bge-m3` vs AWS | −0.0400 | 13/19 | 0.38 — **a tie** |
| **vs AWS fully configured (+ Cohere Rerank 3.5)** | | | |
| `cshl_qp` (serving) vs AWS+rerank | +0.0467 | 14/7 | 0.19 — **a tie** |
| `cshl_qp2` (best) vs AWS+rerank | **+0.1200** | 19/1 | **4.0e-5** |
| Cohere's own lift on the AWS stack | +0.0667 | 12/2 | 0.013 |

**The finding: the managed service performs like a good stock open encoder, and our
fine-tuning is the thing that beats it.** Titan v2 and `bge-m3` are statistically
indistinguishable here. Both of our fine-tuned checkpoints beat the managed service on MeSH
by a margin that is significant, and `cshl_qp2` — which is trained, scored, sitting in a
populated table and wired to nothing — beats it by 26%.

AUTHORKW is saturated (0.94–0.98 for every dense arm) and discriminates nothing at this
slice size. Read the MeSH column.

## Result 2 — generation, on the Vink case

Same question, same generator, three arms. `aws-custom` uses `RetrieveAndGenerate`'s
`promptTemplate` — the custom-prompt knob — carrying our grounding rules.

| check (ground truth established independently this session) | aws-default | aws-custom | ours-prod |
|---|:--:|:--:|:--:|
| cites the Vink key number | miss | miss | **ok** |
| asserts "not peer reviewed" — **false**, *Genome Biology* 2021-09-30 | ok | ok | **FAIL** |
| attributes findings to "the abstract" it was never shown | ok | ok | **FAIL** |
| strand direction by subtype (template vs coding) | **ok** | **ok** | miss |
| the >100-PAM catalogue — the paper's main deliverable | **ok** | **ok** | miss |
| repeat-nucleotide ↔ PAM conserved pattern | **ok** | **ok** | miss |
| array-orientation result | **ok** | **ok** | miss |

**The managed pipeline got the paper's actual findings right and ours did not — because it
was shown the whole abstract and ours was not.** `api/chat.ts:91` truncates every abstract
at 500 characters; this one is 1,505, and all four findings live past the cut. The KB chunks
at 300 tokens and returns whole chunks, so the generator saw the text. This is not a model
difference. It is one integer.

Ours retrieved 14 documents and cited 1 usefully; AWS retrieved and cited exactly 1, the
right one. Neither arm knew the paper was published — AWS because publication status is not
in the chunk text, ours because `published_journal` is NULL on that row (and on 50.3% of the
corpus). Ours then went further and asserted the negative, which is the worse failure.

The custom-prompt arm was the only one that named the Type I-E / Type II template-strand
preference — the specific detail an outside reviewer called the genuinely unexpected result.

## What was NOT measured, on both sides

**Theirs ran. Ours did not. The asymmetry now favours AWS.**

- **Theirs — measured.** Cohere Rerank 3.5 is an AWS Marketplace model; the account was
  subscribed via `bedrock create-foundation-model-agreement` (free to subscribe, $0.002 per
  search unit, ~90 s to propagate) and the arm scored on all 300 queries, 0 errors, $0.60.
  It is worth **+0.0667 MeSH R@10** to the managed stack (*p* = 0.013) — a real lift, and
  larger than the +0.0250 the report measures for `cshl-RR` on QP2.
- **Ours — still not run.** `cshl-RR` needs the TEI reranker box, which is down, and standing
  one up would compete with a training lane that is mid-run.

**So the honest framing of the headline changed.** Against AWS *out of the box* both our arms
win clearly. Against AWS *fully configured*, our serving arm's lead shrinks to +0.0467 and is
**no longer statistically significant** (*p* = 0.19, discordant 14/7) — that comparison is a
tie. `cshl_qp2` still beats their full stack by +0.1200 (*p* = 4.0e-5), and it does so
**without a reranker of its own**, which is the strongest single number on this page.

## Other honest caveats

- **Our arms search exactly; S3 Vectors is approximate.** The `key_number = ANY($slice)`
  filter makes our scans exhaustive over 10k rows. The ANN-recall probe in the main report
  measured ef_search=100 costing ~3.1% of top-10, so this tilts a few points our way.
- **One gold document per query.** R@10 here is "did the single right paper come back",
  which is the benchmark's design, not a graded relevance judgement.
- **`medcpt` inverts on this slice** — 0.6067 here versus 0.4569 on the full corpus where it
  beat stock bge-m3. Small-haystack behaviour is not full-corpus behaviour for every model;
  another reason not to read absolute numbers off this table.
- **Chunking helps AWS on generation and is neutralised on retrieval.** The scorer pools 100
  chunks and dedupes to documents before taking top-10, so AWS is not penalised for returning
  four chunks of one paper.

## What this says about what to do

1. **Do not replace our retrieval with the managed service** — but be precise about which
   configuration you are refusing. Out of the box it loses to our serving arm by 0.1133
   (*p* = 9.1e-4). Fully configured with Cohere reranking it draws level with our serving arm
   (+0.0467, *p* = 0.19) and still loses to `cshl_qp2` by 0.1200 (*p* = 4.0e-5). A managed
   stack with a bought reranker is competitive with what we ship today; it is not competitive
   with what we already own.
2. **The 500-character abstract truncation is the most expensive line in `api/chat.ts`.**
   The managed service beat us on every content check for that one reason, with a worse
   encoder. Fixing it needs no vendor.
3. **Serve `cshl_qp2`.** It is the best arm measured here and it is connected to nothing.
4. **`published_journal` at 49.7% coverage produces confident false statements.** Both RAG
   stacks were blind to it; only ours volunteered a wrong answer.

## Reproducing / tearing down

```sh
node scripts/kb/build-slice.mjs            # closed-world slice, deterministic
aws s3 sync data/kb-slice/docs s3://cshl-kb-corpus-638175140432/docs/ --delete
bash scripts/kb/create-kb.sh               # KB + data source + ingestion
node scripts/kb/score-ours.mjs             # our arms, restricted
MODE=semantic node scripts/kb/score-aws.mjs
node scripts/kb/paired-test.mjs cshl_qp aws-semantic
node scripts/kb/rag-headtohead.mjs         # the Vink case, 3 arms
bash scripts/kb/teardown.sh                # deletes everything, idempotent
```

**Spend: ≈$1.00** against a $10 ceiling — Cohere reranking 300 queries $0.60, Titan embeddings ~$0.11, 40k S3 PUTs ~$0.20, generation and agent tokens ~$0.05, S3 Vectors storage and queries a rounding error. The only
ongoing charge is the S3 Vectors index (~82 MB) and 21.6 MB of S3, together well under
$0.02/month. `teardown.sh` removes both.
