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

### 2026-08-20T02:34Z — MANDATORY PARITY CHECK: passed, and it discriminates

TEI came ready at 02:32Z (`health=200`) after ~3.5 min warming the model on CPU. Then the
check the report calls the most portable thing this program produced — one paper's **exact
indexed text**, taken from the DB through the canonical `recipeSql()` expression, embedded
through the **live** endpoint, cosine against that paper's stored vector in each table.
Three papers, deterministically sampled by `md5('parity:'||key_number)`:

| paper | vs `_cshl_qp` (serving) | vs `_cshl` (CITE) | vs `preprint_embeddings` (stock) |
|---|---:|---:|---:|
| 2023.08.22.23294416 | **0.999998** | 0.464701 | 0.457467 |
| 2025.12.06.692718 | **0.999999** | 0.655088 | 0.632601 |
| 429662 | **0.999998** | 0.582269 | 0.475665 |

Live vectors: dim 1024, L2 norm 1.000000 on all three.

**≈1.0 against the table we serve, and 0.46–0.66 against the one we do not.** The second
column is what makes the first mean anything: a check that only confirms agreement proves
less than one that also shows clear *dis*agreement. Note it is a much wider gap than the
0.77 the report measured for stock-vs-CITE — the query-shaped fine-tune moved the embedding
space considerably further from the citation model than the citation model moved from stock.

Kept as `scripts/serve-nsr/parity-check.mjs` so it is a script and not a habit.

### 2026-08-20T02:35Z — the flip was ALREADY LIVE, and my reweight broke production for ~7 minutes

This is the important entry in this log and it is a mistake of mine.

The report says, of the serving flip: *"The flip itself was deliberately not made tonight."*
I carried that forward and treated the serve box as out of the live path. Before touching
Vercel I probed production to confirm — and it was **already flipped**:

```
POST https://cshl.nysgpt.com/api/chat  ->  200
serve box: docker logs --since 5m tei-enc | grep -c Success  ->  4
           (3 from my parity check + 1 from that /chat request)
```

`SEARCH_ENCODER=nsr`, `NSR_ENCODER_URL` and `NSR_SERVE_KEY` were all created in Vercel
Production at ~19:5xZ — **after** the report line was written. So from the moment my weight
swap completed (~02:32Z) until the deploy went live (~02:39Z), production was running the
`main` build, whose `vectorTable("nsr")` is `preprint_embeddings_cshl` — the **CITE** table —
against a box now serving **qpairs** vectors. One model's query vector searching another
model's space. HTTP 200, plausible titles, no error anywhere.

It is visible in the numbers, which is the only reason it is not a guess. Same question,
same production URL, before and after the deploy:

```
BEFORE (box=qpairs, table=CITE)        AFTER (box=qpairs, table=qpairs)
 0.4120  ASSESSMENT AND CHARACTERIZATION  0.5843  COVCOG 2: Cognitive and Memory Deficits
 0.4061  COVCOG 2: Cognitive and Memory   0.5807  ASSESSMENT AND CHARACTERIZATION
 0.3975  Clearing the Fog: A Systematic   0.5769  COVCOG 1: Factors predicting Cognitive
 0.3950  The impact of a home-based       0.5602  AI-based decoding of long covid ...
```

Degraded, not broken — which is exactly why nothing would have caught it. The "after" list is
also the list the previous lane's verified kNN produced (COVCOG 2 / COVCOG 1 / AI-based
decoding), which is an independent check that the matched configuration is the right one.

**What I actually did wrong:** I trusted a document over a measurement, on the one question
the document was least likely to still be current about. The probe that settled it took
thirty seconds and I ran it *after* the swap instead of before. Either ordering of
swap-then-deploy leaves a window; knowing the flip was live, the correct sequence was
`SEARCH_ENCODER=bge` → reweight → deploy → `SEARCH_ENCODER=nsr`, which has no mismatched
state at any point.

**Blast radius, measured rather than estimated:** the box served 21 requests in the preceding
24 hours, all of them from lanes verifying things, and **zero** in the hour before the swap.
The only request inside the 7-minute window was my own probe. No user query is known to have
hit the mismatch — but "no user was watching" is luck, not a control.

### 2026-08-20T02:39Z — deployed, and the env vars needed no change

`lane/rxiv-load` differs from `main` only in `docs/` and `scripts/` — **no `api/` or `src/`
changes** — so deploying this branch ships main's app code plus this lane's one-line table
change, and nothing else rides along.

```
npx tsc -b        -> 0     (exit code read directly, no pipe)
npm run build     -> 0
commit a1eb752
vercel deploy --prod --yes
  Production  https://cshl-1j2t9v51h-nys-gpt.vercel.app   READY
  Aliased     https://cshl.nysgpt.com
```

**No Vercel environment variable was changed tonight.** All three were already set and all
three are now verified *empirically* rather than by reading them — `vercel env pull` and the
REST API both return `''` for production values because they are marked sensitive, so the
only honest verification is behavioural:

- `SEARCH_ENCODER` is `nsr` — because the dense arm called the box at all.
- `NSR_ENCODER_URL` points at **this** box (`i-08d4dfab74ff44054`) and not at the NSR
  nuclear-physics box the report warned about — because `cshl-serve-cshl` logged the request.
- `NSR_SERVE_KEY` is right — because TEI is `--api-key` gated and returned 200 rather than 401.

### 2026-08-20T02:41Z — /chat verified end to end

Real question, production alias, after the deploy:

```
POST https://cshl.nysgpt.com/api/chat  {"userMessage":"What do preprints say about long
                                        COVID cognitive impairment?","messages":[]}
http=200  12.7 s  SSE stream, 373 data frames
sources.nsr: 8 populated (4 dense @ 0.560-0.584 interleaved with 4 FTS)
answer: 3,336 characters, grounded
```

The answer cites `2020.10.20.20215863` (Hampshire, n=84,285), `2023.12.03.23299331` (Zhao,
cognitive slowing, n=270), both COVCOG preprints by key number, `2025.05.14.654036` and
`2023.11.06.23298101` — i.e. it is answering **from the retrieved sources**, with the
preprint caveat stated, not from the model's own memory.

**Rollback is `SEARCH_ENCODER=bge` plus a redeploy.** That is correct under *any* version of
`api/_lib/embed.ts`, old or new, because `vectorTable("bge")` is `preprint_embeddings` in
both — which is the property that makes it a safe rollback rather than a second flip. A
box-level rollback also exists: the CITE weights are still on the box at `/models/enc.cite`
(md5 `ec06108315187750f9cdbf07813c2de0`); swap the directories back and restart `tei-enc`.

**`preprint_embeddings_cshl` (CITE) is populated, untouched, and staying.** It is the better
document→document encoder and the right arm for "more like this" / reviewer matching. It has
no query-side route today, and anything that adds one must serve the CITE weights, not these.

### 2026-08-20T02:42Z — a hazard the flip creates, flagged rather than fixed

**Production is deployed from `main` by GitHub integration; tonight's fix is a CLI deploy from
`lane/rxiv-load`.** The last three production deploys were: `main` via git (3h ago), then two
CLI deploys from this branch. Whichever is newest wins.

So if anyone pushes `main` before this branch merges, production reverts to a build whose
`vectorTable("nsr")` is `preprint_embeddings_cshl` — while `SEARCH_ENCODER=nsr` stays set and
the box keeps serving qpairs weights. **That is the exact mismatch above, restored silently by
a routine push, with nobody having touched serving.**

This is not mine to resolve — merging `lane/rxiv-load` into `main` is a cross-lane call. It is
the single most likely way tonight's work gets quietly undone, so it is stated here in the
terms someone can act on:

- **Fix:** merge `lane/rxiv-load` (or at minimum commit `a1eb752`) into `main`. The branch
  contains no other `api/` or `src/` change, so the app-code risk of that merge is one line.
- **Detection, if it happens:** `/chat` dense similarities drop from ~0.58 to ~0.41 on the
  long-COVID probe above. Nothing else changes and nothing errors.
- **Immediate mitigation if it happens before the merge:** `SEARCH_ENCODER=bge` + redeploy.

### 2026-08-20T02:42Z — serve box conditions found, not caused, and not fixed tonight

- **`tei-rr` (the reranker on :8081) has restarted 458 times** and is still looping. Cause:
  the box was launched without `RR_RUN`, so `/models/rr` is empty and TEI exits with
  `` `config.json` not found `` on every start. `SEARCH_RERANK` is unset so nothing depends on
  it, and it is not stealing meaningful CPU — but it is a container failing in a loop forever
  on the box that serves the dense arm. Left as found: stopping it would be a second variable
  in a flip that was supposed to have one, and it changes nothing the app can observe.
- TEI logs `Backend does not support a batch size > 4 / forcing max_batch_requests=4` on every
  boot, overriding the rig's `--max-client-batch-size 32`. The flag is accepted and ignored.
- `scripts/serve-nsr/launch.sh` hardcodes `models/<name>/<run>/final`, but this run's weights
  are at `<run>/serve/` (the clean prefix, no optimizer state). A relaunch of that rig with
  `ENC_RUN=20260819-192100-train` would sync an empty directory today.

### 2026-08-20T02:43Z — the encoder-down fallback: tested, not reasoned about

The brief requires that the fallback-binds-table-to-encoder logic keep working. Reading the
code says it does; that is not the same as knowing. Tested on a throwaway preview with a
deliberately dead encoder, so production was never involved:

```
vercel deploy --yes -e NSR_ENCODER_URL=http://127.0.0.1:9/embed
POST <preview>/api/chat  <- same long-COVID question
```

Three things had to be true at once, and were:

| | |
|---|---|
| the serve box was **not** called | `docker logs --since 3m tei-enc \| grep -c Success` → **0** |
| the dense arm did **not** drop | 4 dense rows still returned, interleaved with FTS as usual |
| the **table followed the encoder** | different neighbours at cos 0.63–0.64, i.e. stock bge-m3 space |

Side by side on the identical question — the top dense hit changes from `COVCOG 2` (qpairs
space, 0.5843) to `Cognitive deficits ... N=84,285` (stock space, 0.6386). Both are good
answers; they are *different* answers, which is the point. A box failure costs retrieval
quality and nothing else, and the vectors are never compared across spaces.

Preview deleted after the test so nobody can promote a deployment pinned to a dead encoder.

### 2026-08-20T02:47Z — the publish boxes are slow, and it is the Ubuntu mirror, not them

The encoder publish box sat at `apt-get install -y -q python3-venv awscli` for ~20 minutes.
Measured rather than guessed, from two different boxes in two different subnets and AZs:

| from | to | throughput |
|---|---|---:|
| publish box (t3.small, us-east-1a) | `us-east-1.ec2.archive.ubuntu.com` | **56 kB/s** |
| serve box (t3.large, us-east-1c) | `us-east-1.ec2.archive.ubuntu.com` | **34 kB/s** |
| serve box | `huggingface.co` | **57.7 MB/s** |
| serve box | S3 (`cshl-embed-rxiv`) | 17 MB in seconds |

**A ~1,700× difference between the Ubuntu mirror and everything else.** The boxes are fine;
the in-region Ubuntu mirror is degraded right now. `apt-get update` alone fetched 47.3 MB in
9 min 17 s. The box is making progress — 48 debs, 31 MB cached — so it will finish; the S3
pull and the 2.1 GB HF push that follow are on the fast paths.

I did NOT swap the AMI mid-flight to fix this. Recommended follow-up instead, recorded rather
than done: the publish rig needs apt only for `python3-venv` and `awscli`, both of which
Amazon Linux 2023 ships preinstalled. Moving the publisher off Ubuntu removes the only slow
dependency in the whole path. Doing it tonight, untested, on the night of the flip, is how a
publish that would have worked ends up not working.

**Consequence, acted on:** ran the second publish (`cshl-eval-v1`) on its own box **in
parallel** rather than after, so the two boxes pay the apt cost concurrently instead of
serially. `i-0521de00f1353300c`.

### 2026-08-20T02:48Z — a regression I introduced, caught by dry-running

The tightened placeholder guard I wrote earlier broke the **clean** case:

```
UNFILLED=$(grep -o '{{[A-Z_]\+}}' "$CARD" | sort -u)
```

`grep` exits 1 when it finds nothing, this file runs under `set -euo pipefail`, so a card with
**no** placeholders aborted the script silently at that line — rc=1, no message. A guard that
fails closed on the good input is worse than the bug it replaced. Fixed with `|| true` and a
comment saying why it is load-bearing.

It was caught because the eval publish was dry-run first and the dry run printed nothing
instead of a plan. Both directions re-exercised after the fix: clean card plans and returns 0,
`_CORPUS.md` refuses and names its 10 markers.

### 2026-08-20T02:48Z — the new fusion arms say the flip picked the right arm

Another lane wrote three new arms into `data/eval/cshl-eval-2k/results/` at 02:22–02:24Z
while I was staging — fusions of **both** our encoders. Relevant to this lane because "serve
both" was the obvious alternative to choosing:

| arm | MeSH R@10 | AUTHORKW R@10 |
|---|---:|---:|
| RRF(qpairs + MedCPT + FTS) | **0.5197** | **0.8300** |
| RRF(qpairs + CITE + MedCPT + FTS) | 0.4988 | 0.8182 |
| **qpairs alone** | **0.4319** | 0.7497 |
| RRF(qpairs + CITE + FTS) | 0.4230 | 0.7365 |
| RRF(qpairs + CITE) | 0.4077 | 0.7273 |

**Adding the CITE arm to the query path makes every configuration worse**, including against
qpairs on its own. So serving qpairs alone for query→document is the right call, and CITE's
value really is confined to the document→document task — which is what the card and the
`vectorTable()` comment say. This is the other lane's result, not mine; recorded here because
it independently supports tonight's serving decision and because the numbers came from files
I was about to publish.

**Staging note for auditability.** `data/eval` is being written by another lane concurrently,
so what got pushed is a snapshot, not a stable state. Every staged file was re-copied,
JSON-parsed and checked for a metrics block before upload (a truncated result file parses as
nothing, but a half-written one can parse as an object with no metrics). 35 files, sha256
prefixes recorded in this lane's staging output; `CSHL-CPT-REPORT.md` is the committed
version at `53fc480`. If that lane lands more arms tonight, this repo needs another push.

### 2026-08-20T02:53Z — my own progress waiter reported "done" while nothing was done

Worth recording in full, because it is the third instance tonight of the failure this whole
program is a catalogue of, and this one is entirely mine.

I wrote a background waiter to tell me when the two publish boxes reached a terminal marker.
It fired almost immediately with `both publish boxes terminal`. Both boxes were still running
`apt-get install`.

Cause: the script used `declare -A done_box` for a per-box "already reported" map. **macOS
ships bash 3.2, which has no associative arrays.** `declare -A` failed, then
`done_box[$id]=1` was parsed as *arithmetic* array indexing on an instance id — hence
`value too great for base (error token is "0ad7d19c924aacf21")` — and both failures went to
stderr, which the monitor does not surface as events. The `while` condition then evaluated as
if both boxes were finished, and the script printed its success line and exited 0.

An exit code of 0 and a confident completion message, over two boxes that had done nothing.
The only reason it was caught is that the terminal marker is **not** what this lane treats as
proof: the brief requires listing the repo contents back through the HF API, so the marker was
going to be checked against reality regardless. A rewritten waiter (no associative arrays,
reason in a comment so it does not come back) is now running.

The lesson is the one already in the report and it keeps needing relearning: **the check that
lies is the one you wrote yourself and did not test.** Same shape as the qpairs lane's false
`HNSW-INDEX-READY`, same night.

### 2026-08-20T02:56Z — verification-by-listing-back, as a script

The brief requires every push be verified by listing the repo contents back through the API,
because an upload that dies at 96% looks complete from the process side. Reading a file list
by eye satisfies the letter of that and not much else — it catches an absent file and misses a
truncated one. `scripts/publish-nsr/verify-push.py` compares the Hub against **what was
actually handed to the box** (the S3 prefix the box synced from), per file, by byte size, and
also asserts the card is present and `private == True`.

Exercised in all three directions before it was trusted:

```
NYSgpt/cshl-encoder-bge-m3 vs a NON-EXISTENT prefix
  -> "FAIL: nothing found ... this check would pass vacuously"     (exit 2)
```

That branch exists because the first version printed **"VERIFIED: all 0 sent objects
present"** — a check that passes because it checked nothing, which is the same bug as the
`PUBLISH-DONE` it was written to guard against. Caught by pointing it at a prefix that does
not exist, which is the sort of test that only gets run if you go looking for it.

```
NYSgpt/cshl-eval-v1 vs the staged prefix, BEFORE the push lands
  -> 11x "missing on the Hub" (every qpairs result file + the new fusions)
  -> "size mismatch CSHL-CPT-REPORT.md: sent 56518, hub 41054"     (the pre-qpairs report)
  -> "size mismatch results/cshl.json: sent 4185, hub 4184"        (the re-derived control run)
```

It fails correctly on a repo that has not received the push yet, and the specific failures are
the right ones — which is the only evidence that a passing run later will mean anything.
