# LANE-SHIP — publish the qpairs encoder, then flip serving to it

Append-only, timestamped (UTC). Fence: `api/`, Vercel env, HF publishing, the serve box
(`i-08d4dfab74ff44054`). **Not** this lane's: `scripts/train`, `scripts/eval`, any training
launch. Laptop rule: nothing heavy runs locally.

Two tasks, in order, because the second is the one that can break the live product:

1. **Publish** the qpairs encoder to a NEW private HF repo `NYSgpt/cshl-encoder-bge-m3-qpairs`,
   and the updated report + new results into the existing `NYSgpt/cshl-eval-v1`.
   Every push verified by listing the repo back through the API — an upload that dies at 96%
   looks complete from the process side.
2. **Flip serving** to the qpairs weights. One variable, reversible (`SEARCH_ENCODER=bge`).
   Mandatory served-model parity check before it is called done: cosine ≈1.0 against
   `preprint_embeddings_cshl_qp` **and** clearly lower against `preprint_embeddings` — both
   numbers in this log, because the check that only confirms agreement proves less than the
   one that also shows disagreement.

---

## Log

### 2026-08-20T02:14Z — lane start, state read before anything was touched

Pulled `lane/rxiv-load` (already up to date; the rig merge `e931cc4` is in). Read
`docs/prompts/LANE-QPAIRS-RUN.md` end to end, the Serving section and the parity-check
section of `docs/CSHL-CPT-REPORT.md`, `api/_lib/embed.ts`, `api/chat.ts`,
`scripts/serve-nsr/launch.sh`, `scripts/publish-nsr/launch.sh`.

Measured state, not assumed:

```
aws sts get-caller-identity  -> 638175140432 / user 2525-cli
weights present at s3://cshl-embed-rxiv/models/cshl-encoder-bge-m3/20260819-192100-train/serve/
  model.safetensors 2.1 GiB · config.json · sentence_bert_config.json · tokenizer.json 16.3 MiB
  modules.json · 1_Pooling/ · sentencepiece.bpe.model · special_tokens_map.json
  tokenizer_config.json · training_args.bin        (no optimizer state — the clean `serve/` prefix)
serve box i-08d4dfab74ff44054  t3.large  54.227.19.163  running since 2026-08-19T18:57Z
  SSM agent Online (ping 22:14:36-04:00) — so the reweight can be done in place
no GPU box running (the rig lane's g5.12xlarge rehearsal box is gone)
```

The weights live under `serve/`, not `final/`. `scripts/serve-nsr/launch.sh` hardcodes
`<run>/final` — noted here because the reweight is done in place over SSM rather than by
relaunching that rig, so the mismatch is not hit tonight but would bite a future relaunch.

### 2026-08-20T02:20Z — three defects found in the publish path BEFORE using it

The brief says "use the publish rig — it hard-refuses non-private pushes." Measured against
the script, that is **not true as written**, and two more things would have made tonight's
publish report success while pushing nothing. All three are inside this lane's fence
(HF publishing), so all three are fixed before anything is pushed.

**(a) The non-private refusal is not universal.** `scripts/publish-nsr/launch.sh` gates on the
repo name:

```
case "$REPO" in *triplets*|*eval-v1*|*corpus*|*query-pairs*) ...refuse if PRIVATE != True... ;; esac
```

`cshl-encoder-bge-m3-qpairs` matches **none** of those patterns — `qpairs` is not
`query-pairs`. `PRIVATE=False` on tonight's model repo would have sailed straight through.
The default is `True`, so the accident needs someone to type `PRIVATE=False`, but "the tool
refuses" and "the default is safe" are different guarantees and Brendan ruled PRIVATE ONLY.

**(b) `/cshl/hf/token` does not exist.** `aws ssm describe-parameters` returns
`/nsr/hf/token` and no CSHL equivalent. The script's own header comment claims it "falls back
to NSR's `/nsr/hf/token` if that is what exists" — **the fallback was never implemented**;
the body reads `HF_TOKEN_PARAM` and nothing else.

**(c) The publish box cannot read the token even if pointed at it, and would not say so.**
`cshl-embed` carries three inline policies — `read-dburl`, `serve-apikey`,
`write-eval-artifacts` — and their combined `ssm:GetParameter` grants are exactly
`/cshl/embed/dburl` and `/cshl/serve/api-key`. No HF token. The user-data runs under
`set -uo pipefail` with **no `-e`**, and `echo PUBLISH-DONE` sits unconditionally after the
python heredoc. So the sequence is: token fetch fails → `HF_TOKEN=""` → `create_repo` raises →
python exits non-zero → **`PUBLISH-DONE` prints anyway** → log uploads → box terminates.
A clean-looking run, an empty Hub, and a terminated box to ask about it.

This is the same failure the qpairs lane hit from the other side (`launch.sh` clobbering an
`eval/*` grant it had verified ten minutes earlier), and the same shape the report's whole
failure catalogue is made of.

Verified working, so the fix is a grant and not a new secret:

```
GET /api/whoami-v2 with /nsr/hf/token -> {"name":"NYSgpt", ..., "auth":{"type":"oauth",
  "expiresAt":"2026-08-30T08:24:16.000Z"}}
```

**That token is an OAuth token and it expires 2026-08-30.** Publishing stops working in ten
days with an authentication error, not a silent one. Recorded so the next lane does not
rediscover it under time pressure.

Existing `NYSgpt` repos, listed through the API rather than assumed — all private, and note
that `cshl-eval-v1` and `cshl-triplets` are **`repo_type=model`**, not `dataset`:

```
cshl-encoder-bge-m3 True · cshl-eval-v1 True · cshl-triplets True
nsr-encoder-bge-m3 True · nsr-reranker-gte-modernbert True · nsr-retrieval-benchmark True
nsr-training-triplets True · nsr-corpus-embeddings True · 44b-training-pairs True
44b-reranker-benchmark True · 44b-reranker-gte-modernbert False · 44b-reranker-minilm-l6 False
```

`?author=NYSgpt&type=dataset` returns empty. Tonight's pushes therefore use `TYPE=model`,
matching what is already there rather than creating a second namespace for the same program.

### 2026-08-20T02:24Z — publish rig hardened, then dry-run, then fired

Four changes to `scripts/publish-nsr/launch.sh`, all inside this lane's fence:

1. **The PRIVATE-only refusal is now universal**, lifted out of the name-matched case. Any
   `PRIVATE != True` is refused for any repo, with the same deliberately-ugly override.
2. **`*qpairs*` added to the text-bearing pattern list**, which now only carries the *extra*
   licence-table requirement. The 424,753-row query-pairs set inlines abstracts exactly the
   way the triplets do, and `qpairs` is the short name anyone would reach for.
3. **HF token resolution implemented** (`/cshl/hf/token` → `/nsr/hf/token`), on the laptop,
   where the failure is visible and free — plus a `read-hf-token` inline policy on
   `cshl-embed` for whichever one resolves. Its own policy *name* on purpose: `put-role-policy`
   replaces by name, and the train rig re-puts its own policy on every launch.
4. **The box's user-data no longer reports success unconditionally.** Empty token → named
   failure and shutdown; python exit code checked; `PUBLISH-DONE` only on a zero exit. The box
   also lists the repo back and prints the file count.

A fifth, found while dry-running: the placeholder guard tested for a bare `{{`, which also
matches the literal `{{...}}` inside the maintainer comment that **every card in this program
carries**. So every existing card was unpublishable, and the refusal printed an *empty* list of
offenders because that list is built with the narrower `{{[A-Z_]*}}` pattern. Tightened the
test to the pattern it prints, and dropped the comment from the card being published.

Both directions exercised before the real run:

```
DRYRUN=1 ... REPO=NYSgpt/cshl-encoder-bge-m3-qpairs  -> plan printed, rc=0, hf token /nsr/hf/token
PRIVATE=False ...                                    -> "REFUSING: PRIVATE=False", rc=1
CARD=cards/_CORPUS.md                                -> refused, and NAMED all 10 markers
```

Fired at 02:20Z:

```
SRC=s3://cshl-embed-rxiv/models/cshl-encoder-bge-m3/20260819-192100-train/serve/
REPO=NYSgpt/cshl-encoder-bge-m3-qpairs  TYPE=model  PRIVATE=True
instance i-0ad7d19c924aacf21 (t3.small)
```

The card is written from the artifacts, not from prose: pair counts and the emitted family
mix from `data/train/qpairs/manifest.json`, every retrieval number re-read from
`data/eval/cshl-eval-2k/results/*.json` and `data/eval/cshl-eval-docdoc/results/*.json`. It
states, because the brief requires it and because a card that omits them is worse than none:
**40k pairs in a proportional mix** (EXTRACT 24,477 · MESH 9,668 · AUTHORKW 5,854, counted in
what was *emitted*), **batch 8 after the OOM at 16** on the L40S with the OOM text quoted,
**passage length 384**, the **MeSH parity with MedCPT** (p=0.071, CI crosses zero), the
**AUTHORKW loss** (p=0.0003, and explicitly not rounded off), and the **doc→doc trade**
(0.2120 → 0.1980, and indistinguishable from the base model it started from at p=0.78).

### 2026-08-20T02:29Z — repo types corrected

Earlier I recorded `cshl-eval-v1` and `cshl-triplets` as `repo_type=model`. **Wrong** — I read
the output of two `curl`s as one block. Listed separately:

```
models  : cshl-encoder-bge-m3 · nsr-encoder-bge-m3 · nsr-reranker-gte-modernbert
          44b-reranker-gte-modernbert · 44b-reranker-minilm-l6           (last two PUBLIC)
datasets: cshl-eval-v1 · cshl-triplets · nsr-retrieval-benchmark · nsr-training-triplets
          nsr-corpus-embeddings · 44b-training-pairs · 44b-reranker-benchmark   (all private)
```

The encoder push is `TYPE=model` and is unaffected. The eval push is **`TYPE=dataset`**.
`NYSgpt/cshl-eval-v1` last modified 2026-08-19T20:59Z, i.e. before any qpairs artifact existed.

### 2026-08-20T02:26Z — TASK 2, step 1: the serve box now holds the qpairs weights

**Checked first whether the box was in the live path**, because reweighting one that is
serving traffic breaks every in-flight query. Read from the box, not assumed:

```
docker logs --since 60m tei-enc | grep -c embed  ->  0
docker logs --since 24h tei-enc | grep -c embed  -> 21   (clustered 19:04-19:15Z and 20:36Z,
                                                          i.e. the previous lane's verification runs)
```

Zero requests in the last hour, last one ~1.5 h ago. Safe to reweight in place.

Also recorded from that read, neither of them mine to fix tonight:
- **`tei-rr` (the reranker, :8081) is crash-looping** — `Restarting (1)` on every inspection.
  `SEARCH_RERANK` is not set, so nothing depends on it, but it is not healthy either.
- TEI logs `Backend does not support a batch size > 4 / forcing max_batch_requests=4` despite
  the rig passing `--max-client-batch-size 32`. The flag is accepted and then overridden.

**Done in place over SSM rather than by relaunching `scripts/serve-nsr/launch.sh`.** That rig
hardcodes `<run>/final` and these weights are at `<run>/serve/`, and relaunching would change
the box's public IP — which would turn a one-variable flip into a flip plus a Vercel env
change plus a redeploy. Same S3-pull pattern, one variable.

```
aws s3 sync s3://.../20260819-192100-train/serve/ /models/enc.new/
  10 files + 1_Pooling/config.json
  model.safetensors  2,271,064,456 bytes   == the byte count S3 lists for the object
  md5 7a508120e27bd708ea5bcd070fa435c2     != ec06108315187750f9cdbf07813c2de0 (the CITE
                                              weights that were mounted) — genuinely different
  sentence_bert_config.json {"max_seq_length": 384, ...}  <- TEI reads p384 from the checkpoint
```

Then: stop `tei-enc` → `mv /models/enc /models/enc.cite` → `mv /models/enc.new /models/enc` →
start. The CITE weights are **kept on the box** at `/models/enc.cite`, so there is a
box-level rollback (swap the directories back, restart) in addition to the app-level one.
Dropped `/models/enc.cite/checkpoint-10000` — 2.2 GB of training checkpoint that the CITE
sync pulled from `final/` and that a serving box has no use for.

Confirmed after the swap: `/models/enc/model.safetensors` md5 is `7a508120…`. TEI restarted
and is warming the model (this box takes ~3.5 min on CPU; the ORT-backend error in its log is
normal — there is no ONNX export, so it falls back to Candle, same as the previous boot).
