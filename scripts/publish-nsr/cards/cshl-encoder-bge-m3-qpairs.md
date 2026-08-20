---
license: mit
base_model: BAAI/bge-m3
library_name: sentence-transformers
pipeline_tag: feature-extraction
tags: [retrieval, biomedical, preprints, biorxiv, medrxiv, bge-m3]
---

# cshl-encoder-bge-m3-qpairs

A dense retrieval encoder for **bioRxiv + medRxiv preprints**, contrastively
fine-tuned from [`BAAI/bge-m3`](https://huggingface.co/BAAI/bge-m3) on
**query→document** supervision. 1024-d, CLS pooling, normalized embeddings.
Serves the dense arm of RxivGPT.

This is the **query-shaped** sibling of
[`NYSgpt/cshl-encoder-bge-m3`](https://huggingface.co/NYSgpt/cshl-encoder-bge-m3),
which was trained on citation-based **document→document** pairs. They are two
different models for two different tasks and **both are kept**:

| use it for | model |
|---|---|
| a user types a question / keywords → find papers | **this model** |
| "more like this paper", reviewer matching, systematic-review expansion | `cshl-encoder-bge-m3` (CITE) |

## What changed, and what it cost

The CITE model scored MeSH R@10 **0.3320** against `ncbi/MedCPT`'s **0.4569**. The
standing hypothesis for that shortfall was an **objective mismatch** — trained
doc→doc, evaluated query→doc. This model tests it, on the same frozen benchmark.

- **MeSH R@10 0.3320 → 0.4319, +30.1% relative.** The gap to MedCPT went 0.1249 → 0.0250,
  closing **80%** of the deficit. Paired McNemar vs CITE: **p = 2.3e-16**.
- **On MeSH this model is no longer statistically distinguishable from MedCPT** —
  paired McNemar p = 0.071, bootstrap 95% CI [−0.0516, +0.0016], which crosses zero.
- **On author keywords MedCPT is still genuinely better and this is not a rounding
  error**: 0.7497 vs 0.8076, p = **0.0003**, CI [−0.0883, −0.0277]. It does not go away
  under a kind reading and it is not presented as if it does.
- **Document→document regressed, and worse than "a little":** R@10 0.2120 → 0.1980
  (p = 0.043) — and at 0.1980 it is **statistically indistinguishable from the base
  model it was fine-tuned from** (stock bge-m3, 0.1955, p = 0.78). The citation training
  bought a real doc→doc advantage; training on queries did not dent it, it **spent all
  of it**. That is why the CITE model stays published and stays served for doc→doc work.

**One confound, stated up front.** This run moved two levers at once: the objective
(doc→doc → query→doc) **and** the effective batch (4 → 8, because the L40S fit 8 where the
A10G fit 4). A single run cannot separate them; two clean runs did not fit the budget. What
bounds it: the CITE run measured batch-4 fine-tuning at +0.046 MeSH over stock, and this run
added **+0.0999** on top — and the doc→doc side moved in the *opposite* direction at the same
batch size, which is what an objective change looks like and not what a capacity change looks
like. Read the +30% as "query supervision at batch 8", never as "query supervision alone".

## Training

| | |
|---|---|
| base | `BAAI/bge-m3` |
| objective | in-batch contrastive, dense only (`--unified_finetuning False`), temperature 0.02 |
| trainer | FlagEmbedding `finetune.embedder.encoder_only.m3` |
| supervision | **query→document** — `cshl-query-pairs`, literal query strings, not paper slugs |
| pairs | **39,999**, subsampled from 424,753 |
| family mix | proportional: EXTRACT 24,477 · MESH 9,668 · AUTHORKW 5,854 |
| negatives / pair | 8 mined (group size 8 = 1 positive + 7 negatives) |
| query / passage max len | **128 / 384** tokens |
| batch / epochs / lr | **8** / 1 / 1e-5 |
| precision | bf16 |
| hardware / wall-clock | 1× **NVIDIA L40S** (g6e.2xlarge, 44.4 GiB usable), 4,999 steps at 1.52 it/s, ~55 min |
| run id | `20260819-192100-train` |

**Batch 8 is a fallback, not a plan.** The run was launched at `BATCH=16` and OOMed on the
L40S ~2 minutes in (`Tried to allocate 384.00 MiB; 151.38 MiB free of 44.39 GiB`); the rig's
OOM guard halved to 8 and restarted. Effective batch is therefore 2× the CITE run's 4, not
the 4× the plan assumed — ~7 in-batch negatives per example rather than ~15. Recorded because
"trained at batch 16" is what the launch command says and it is not what the weights are.

The family mix is **proportional to the source set and counted in what was emitted**, not in
what was read — a converter that reports families from its input can claim a balanced mix
while writing something else.

**Query shape, measured on the emitted file rather than asserted:** query side averages 110
characters (min 11, max 273); positives average 1,768 characters. That ratio *is* the
experiment — the CITE set had a full abstract on both sides.

Sequence length note: `sentence_bert_config.json` ships `max_seq_length: 384`, so a serving
stack that reads the checkpoint (TEI does) matches the passage length it was trained at
without being told.

## Evaluation

Scored on the frozen 2,000-query subsample of `cshl-eval-v1`
([`NYSgpt/cshl-eval-v1`](https://huggingface.co/NYSgpt/cshl-eval-v1), MESH 1,241 ·
AUTHORKW 759), full-corpus retrieval against **433,449** papers, `hnsw.ef_search=100`.
Baselines were measured on the **same** queries and the **same** corpus, not quoted from
their own papers. Never scored on training data.

### Query → document

| arm | MeSH R@1 | MeSH R@10 | MeSH nDCG@10 | AUTHORKW R@1 | AUTHORKW R@10 | AUTHORKW nDCG@10 |
|---|---:|---:|---:|---:|---:|---:|
| RRF(**this** + MedCPT + FTS) | 0.2716 | **0.5197** | **0.3879** | 0.6047 | **0.8300** | **0.7197** |
| RRF(CITE + MedCPT + FTS) | 0.2369 | 0.4722 | 0.3454 | 0.5626 | 0.8235 | 0.6915 |
| `ncbi/MedCPT` | 0.2345 | 0.4569 | 0.3373 | 0.5731 | 0.8076 | 0.6885 |
| RRF(**this** + FTS) | 0.2305 | 0.4512 | 0.3333 | 0.5441 | 0.7655 | 0.6540 |
| **this model** | **0.2224** | **0.4319** | **0.3190** | **0.5336** | **0.7497** | **0.6395** |
| `allenai/specter2_base` | 0.1531 | 0.3513 | 0.2471 | 0.4967 | 0.7260 | 0.6103 |
| `cshl-encoder-bge-m3` (CITE) | 0.1571 | 0.3320 | 0.2367 | 0.4611 | 0.6693 | 0.5625 |
| stock `BAAI/bge-m3` | 0.1176 | 0.2861 | 0.1942 | 0.4572 | 0.6522 | 0.5524 |
| Postgres FTS | 0.0467 | 0.0806 | 0.0626 | 0.2174 | 0.2398 | 0.2286 |

Paired McNemar on the same queries in the same order:

| comparison | family | n | ΔR@10 | exact p | bootstrap 95% CI |
|---|---|---:|---:|---:|---|
| vs CITE | MESH | 1,241 | **+0.0999** | 2.3e-16 | [+0.0766, +0.1225] |
| vs CITE | AUTHORKW | 759 | **+0.0804** | 5.0e-9 | [+0.0540, +0.1080] |
| vs MedCPT | MESH | 1,241 | −0.0250 | **0.071** | **[−0.0516, +0.0016]** |
| vs MedCPT | AUTHORKW | 759 | −0.0580 | 0.0003 | [−0.0883, −0.0277] |

### Document → document — the regression, with its number

| arm | R@1 | R@10 | R@50 | MRR |
|---|---:|---:|---:|---:|
| `cshl-encoder-bge-m3` (CITE) | 0.0700 | **0.2120** | 0.3445 | 0.1167 |
| **this model** | 0.0630 | **0.1980** | 0.3145 | 0.1061 |
| stock `BAAI/bge-m3` | 0.0620 | 0.1955 | 0.2900 | 0.1053 |
| `allenai/specter2_base` | 0.0665 | 0.1960 | 0.3025 | 0.1075 |
| `ncbi/MedCPT` | 0.0580 | 0.1790 | 0.3020 | 0.0985 |

| comparison | ΔR@10 | exact p | bootstrap 95% CI |
|---|---:|---:|---|
| vs CITE | **−0.0140** | 0.043 | [−0.0275, −0.0010] |
| vs stock `BAAI/bge-m3` | +0.0025 | **0.78** | [−0.0110, +0.0165] |
| vs MedCPT | +0.0190 | 0.015 | [+0.0040, +0.0340] |

Per-segment numbers (server, era, abstract length) are in `results/` on the benchmark repo.

## Limitations

- **MedCPT is still significantly better on author-keyword queries** (0.7497 vs 0.8076,
  p = 0.0003). Parity was reached on MeSH, not everywhere.
- **This model is a worse document→document encoder than its CITE sibling**, and no better
  than stock bge-m3 at that task. Use the CITE model for "more like this".
- The +30% cannot be attributed to the objective change alone — see the confound above.
- English-only in practice, though the bge-m3 base is multilingual.
- Documents are truncated at 4,000 characters; the tail of a long methods-heavy abstract is
  not represented. Trained on abstracts, not full text or figures.
- 157 of the 39,999 emitted training queries share their literal text with a benchmark query.
  This is **not** a leak — the benchmark holds out by *paper*, and the emitted set references
  **zero** held-out gold papers (independently re-scanned after emission, against 6,203 gold
  papers) — but it is the first thing a reader should ask about, so it is measured rather
  than argued.
- ~1% of training rows carry fewer than 7 negatives; FlagEmbedding samples with replacement
  for those.

## Usage

```python
from sentence_transformers import SentenceTransformer
m = SentenceTransformer("NYSgpt/cshl-encoder-bge-m3-qpairs")
v = m.encode(["CRISPR base editing off-target effects"], normalize_embeddings=True)
```

Both sides must be normalized and compared with cosine: the corpus side is embedded through
TEI, which normalizes, and the registry metric for this arm is `cosine`. Querying one model's
vector space with another model's vector returns confident nonsense with no error — if you
swap encoders, swap the corpus table with it.

<!-- Shared corpus/provenance block, verbatim from cshl-encoder-bge-m3. -->

## Corpus

Both preprint servers operated by **Cold Spring Harbor Laboratory**:

| server | papers | posted range | with a published journal DOI |
|---|---:|---|---:|
| bioRxiv | 345,882 | 2013-11-07 → 2026-08-18 | 176,056 (50.9%) |
| medRxiv | 87,567 | 2019-06-25 → 2026-08-18 | 39,352 (44.9%) |
| **total** | **433,449** | | **215,408 (49.7%)** |

- **Source:** the public bioRxiv/medRxiv APIs (`api.biorxiv.org`, `api.medrxiv.org`),
  unauthenticated, harvested 2026-08-19.
- **Unit of record:** a paper, not a version. A source row is a *version*; the hub keeps
  `max(version)` per `(server, doi)` and full history lives in a sidecar.
- **Business key:** the bare DOI suffix (`2026.07.31.741992`, `19000109`), which survives the
  2026 DOI prefix change (`10.1101` → `10.64898`), with a `UNIQUE (server, doi)` collision guard.
- **Indexed text:** `left(trim(title || "\n\n" || abstract), 4000)` — abstract coverage on this
  corpus is ~100% (measured: 0 rows without an abstract), median 1,941 characters, p99 4,763.

## Licensing — measured, not assumed

Preprint metadata and abstracts are redistributed by the servers under **per-paper**
licences. This corpus is not uniformly permissive:

| licence | share | derivatives redistributable? |
|---|---:|---|
| `cc_by_nc_nd` | 35.1% | **no — no derivatives** |
| `cc_no` | 28.3% | **no — all rights reserved** |
| `cc_by` | 21.6% | yes |
| `cc_by_nc` | 8.1% | yes, non-commercial |
| `cc_by_nd` | 5.5% | **no — no derivatives** |
| `cc0` | 1.0% | yes |
| `cc0_ng` | 0.3% | yes |
| `unstated` | 0.1% | unknown |

`cc_no` means **all rights reserved**, not a Creative Commons licence — a prefix match on
`cc` reports the opposite of the truth, and did once before this table was generated from
the data.

**This repo ships weights, not text.** It is **private**, per standing policy for this
program. Making it public is a decision about a model derived from third-party content and
is not ours to take unilaterally.

## Split discipline

25% of *papers* are held out by `md5("holdout:" || key_number)`, frozen before any training,
and the same hash rule is used by the benchmark builder, the encoder triplet converter and
the query-pair converter — so a held-out paper cannot appear as a positive, a negative, or an
anchor anywhere in training. The converters audit what they **emit** (not what they read) and
refuse to write a set that leaks; this run's converter aborts with a non-zero exit rather than
writing an empty slice, because the previous version wrote one and printed its success line.
