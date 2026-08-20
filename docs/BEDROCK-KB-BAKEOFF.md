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

The size of the effect, same encoder, same queries:

| `cshl_qp` MeSH R@10 | on 433,449 docs | on the 10k slice |
|---|---|---|
| | 0.4319 | **0.8267** |

That gap is the entire reason for the restriction.

## Result 1 — retrieval (300 queries, closed slice, R@10 after chunk→document dedupe)

| arm | MeSH R@10 | AUTHORKW R@10 | blended |
|---|---:|---:|---:|
| **`cshl_qp2`** — our best encoder, unserved | **0.9000** | 0.9733 | **0.9367** |
| **`cshl_qp`** — what /chat serves today | **0.8267** | **0.9800** | 0.9033 |
| **AWS managed KB** (Titan v2, semantic) | 0.7133 | 0.9467 | 0.8300 |
| stock `bge-m3` | 0.6733 | 0.9400 | 0.8067 |
| `medcpt` | 0.6067 | 0.9000 | 0.7533 |
| our FTS arm | 0.1067 | 0.2400 | 0.1733 |

Paired McNemar on the discordant queries (both arms answered the identical 300):

| comparison | MeSH Δ | discordant | *p* |
|---|---:|---:|---:|
| `cshl_qp` (serving) vs AWS | **+0.1133** | 21/4 | **9.1e-4** |
| `cshl_qp2` (best) vs AWS | **+0.1867** | 29/1 | **5.8e-8** |
| stock `bge-m3` vs AWS | −0.0400 | 13/19 | 0.38 — **a tie** |

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

**Neither reranker ran, and the gap is symmetric.**

- **Theirs**: Cohere Rerank 3.5 is the only rerank model available in this account, and it is
  an AWS **Marketplace** model — it returns `AccessDenied` until someone accepts
  `aws-marketplace:Subscribe`. That is an account-level commercial agreement, so it was left
  for a human. One subscription and `MODE=rerank node scripts/kb/score-aws.mjs` completes it.
- **Ours**: `cshl-RR` needs the TEI reranker box, which is not up, and standing one up would
  have competed with a training lane that is mid-run.

So this is **encoder vs encoder**, cleanly. On the full corpus the report measures `cshl-RR`
at +0.0250 MeSH on QP2; Cohere would presumably lift AWS similarly. Do not read the table as
a system-vs-system verdict — the earlier `cshl-QP2`+`cshl-RR` vs MedCPT's full stack row is
what a system comparison looks like, and it took its own run.

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

1. **Do not replace our retrieval with the managed service.** It loses to what we already
   serve by 0.1133 MeSH R@10 (*p* = 9.1e-4) and to what we already own by 0.1867.
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

**Spend: ≈$0.40** against a $10 ceiling — Titan embeddings ~$0.11, 40k S3 PUTs ~$0.20,
generation and agent tokens ~$0.05, S3 Vectors storage and queries a rounding error. The only
ongoing charge is the S3 Vectors index (~82 MB) and 21.6 MB of S3, together well under
$0.02/month. `teardown.sh` removes both.
