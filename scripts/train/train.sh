#!/bin/bash
# train rig box-side script (CSHL / RxivGPT) — runs on the g6e.xlarge launched
# by scripts/train/launch.sh (PyTorch DLAMI). Ported from scripts/train-nsr/
# train.sh at 8c1b05b.
#
# The three environment facts below were paid for on NSR with 4 failed boots
# and ~$0.51 of blind iteration. They are inherited verbatim because the AMI is
# the same; re-verify only if the AMI id changes.
#   1. Python with torch is /opt/pytorch/bin/python3 (a dedicated venv, 3.12) —
#      NOT /usr/bin/python3 (3.10, no ML libs at all).
#   2. transformer_engine (pre-installed, imported transitively by
#      peft->transformers.Trainer) dlopens libcudnn_graph.so.9, which lives
#      under site-packages/nvidia/cudnn/lib but is not on the loader path.
#      LD_LIBRARY_PATH must include every nvidia/*/lib dir, every invocation.
#   3. FlagEmbedding 1.4.0's AbsTrainer._save touches Trainer.tokenizer, which
#      transformers 5.x dropped — AttributeError at the SAVE step, AFTER a full
#      successful run. Pin transformers to FlagEmbedding's declared floor.
#
# CHANGED vs the NSR original:
#   - MODEL_NAME / BASE_MODEL / GROUP_SIZE / QUERY_MAX_LEN / PASSAGE_MAX_LEN are
#     env knobs. PASSAGE_MAX_LEN defaults to 512, not NSR's 256: this corpus is
#     ~100% abstracts averaging ~470 bge-m3 tokens at the 4000-char cap, so 256
#     would truncate the training passage to roughly half the document the
#     embed rig actually indexes — training and serving would see different text.
#   - the batch search starts from BATCH and halves on OOM (unchanged), but the
#     starting point is 8 rather than 16 because doubling passage_max_len
#     roughly doubles activation memory. The OOM loop makes this self-correcting
#     in both directions; the log records what actually held.
#   - Phase 3 (corpus re-embed with the fresh checkpoint) is GONE from this
#     script — it belongs to the embed rig now. See launch.sh's header.
#   - the rehearsal sanity check no longer needs a DB: it embeds the training
#     slice's own passages. One less credential on the box.
set -euo pipefail
: "${MODE:?}" "${TRAIN_NAME:?}" "${RUN_ID:?}" "${BUCKET:?}"
EVAL_VERSION=${EVAL_VERSION:-cshl-eval-v1}
MODEL_NAME=${MODEL_NAME:-cshl-encoder-bge-m3}
BASE_MODEL=${BASE_MODEL:-BAAI/bge-m3}
EPOCHS=${EPOCHS:-1}
BATCH=${BATCH:-8}
GROUP_SIZE=${GROUP_SIZE:-8}
QUERY_MAX_LEN=${QUERY_MAX_LEN:-128}
PASSAGE_MAX_LEN=${PASSAGE_MAX_LEN:-512}
OUT=/opt/train/out
NPROC=${NPROC:-1}
TORCHRUN=/opt/pytorch/bin/torchrun
echo "[train.sh] MODE=$MODE TRAIN_NAME=$TRAIN_NAME RUN_ID=$RUN_ID base=$BASE_MODEL q=$QUERY_MAX_LEN p=$PASSAGE_MAX_LEN group=$GROUP_SIZE nproc=$NPROC"

PY=/opt/pytorch/bin/python3
SP=/opt/pytorch/lib/python3.12/site-packages
export LD_LIBRARY_PATH="$(find "$SP/nvidia" -maxdepth 2 -type d -name lib | tr '\n' ':')"

# DRYRUN: print the exact resolved training command (single- or multi-GPU)
# and exit — no install, no S3, no GPU, no box required. Uses a placeholder
# pair count (DRYRUN_N_PAIRS, default 40000 — the real slice's rough size) so
# the printed steps/warmup match what a real run would compute.
if [ -n "${DRYRUN:-}" ]; then
  N_PAIRS=${DRYRUN_N_PAIRS:-40000}
  if [ "$NPROC" -gt 1 ]; then
    RUN_PREFIX="$TORCHRUN --standalone --nproc_per_node=$NPROC"
    EFFECTIVE_BATCH=$((BATCH * NPROC))
  else
    RUN_PREFIX="$PY"
    EFFECTIVE_BATCH=$BATCH
  fi
  STEPS_PER_EPOCH=$(( (N_PAIRS + EFFECTIVE_BATCH - 1) / EFFECTIVE_BATCH ))
  WARMUP=$(( STEPS_PER_EPOCH / 10 )); [ "$WARMUP" -lt 1 ] && WARMUP=1
  echo "[train.sh][DRYRUN] N_PAIRS=$N_PAIRS NPROC=$NPROC per_device_batch=$BATCH effective_batch=$EFFECTIVE_BATCH steps_per_epoch=$STEPS_PER_EPOCH warmup_steps=$WARMUP"
  echo "[train.sh][DRYRUN] would run (via /opt/train/run_trainer.py, a thin wrapper that patches"
  echo "[train.sh][DRYRUN] Trainer._issue_warnings_after_load before import — see the comment in section 3):"
  cat <<PLAN
$RUN_PREFIX /opt/train/run_trainer.py \\
  --model_name_or_path $BASE_MODEL \\
  --cache_dir /opt/train/hf-cache \\
  --train_data train.jsonl \\
  --cache_path /opt/train/data-cache \\
  --train_group_size $GROUP_SIZE \\
  --query_max_len $QUERY_MAX_LEN \\
  --passage_max_len $PASSAGE_MAX_LEN \\
  --pad_to_multiple_of 8 \\
  --knowledge_distillation False \\
  --unified_finetuning False \\
  --use_self_distill False \\
  --output_dir $OUT \\
  --learning_rate ${LR:-1e-5} \\
  --bf16 \\
  --num_train_epochs $EPOCHS \\
  --per_device_train_batch_size $BATCH \\
  --dataloader_drop_last True \\
  --warmup_steps $WARMUP \\
  --logging_steps 10 \\
  --save_steps ${SAVE_STEPS:-600} \\
  --save_total_limit ${SAVE_TOTAL_LIMIT:-3} \\
  --temperature 0.02 \\
  --sentence_pooling_method cls \\
  --normalize_embeddings True
PLAN
  exit 0
fi

# 1. Install. Base FlagEmbedding (no [finetune] extra — its flash-attn/deepspeed
#    deps don't build on this box and encoder_only.m3 never imports either),
#    then pin transformers <5 (header fact 3).
$PY -m pip install -U FlagEmbedding 2>&1 | tail -40
$PY -m pip install "transformers>=4.44.2,<5" 2>&1 | tail -10
echo "[train.sh] --help for the INSTALLED version (use ITS flags, don't guess):"
$PY -m FlagEmbedding.finetune.embedder.encoder_only.m3 --help 2>&1 | tee /opt/flagembed-help.txt || true

# 2. Pull the converted training slice
mkdir -p /opt/train && cd /opt/train
aws s3 cp "s3://$BUCKET/train/$TRAIN_NAME/train.jsonl" train.jsonl
aws s3 cp "s3://$BUCKET/train/$TRAIN_NAME/manifest.json" manifest.json || true
N_PAIRS=$(wc -l < train.jsonl)
echo "[train.sh] $N_PAIRS training pairs in $TRAIN_NAME"
# The gate that NSR learned the hard way: never train on a set whose manifest
# does not assert disjointness from the eval holdout.
if [ -f manifest.json ]; then
  $PY -c "
import json,sys
m=json.load(open('manifest.json'))
d=m.get('disjointness',{})
print('[train.sh] manifest disjointness:', json.dumps(d))
sys.exit(0 if d.get('pass') is True else 1)
" || { echo '[train.sh] manifest says disjointness.pass != true — refusing to train'; exit 1; }
else
  echo '[train.sh] WARNING: no manifest.json beside the slice — training on an unaudited set'
fi

# 3. Train (dense-only bge-m3 finetune).
#    --overwrite_output_dir and --warmup_ratio do NOT exist in this installed
#    version's TrainingArguments (confirmed via --help on NSR): rm -rf instead,
#    and compute --warmup_steps.
export OUT_DIR="$OUT"
CKPT_FLAG=""

# --resume_from_checkpoint bug, found and fixed by this lane's acceptance
# test (not reasoned about — see docs/prompts/LANE-RIG-UPGRADE.md): on the
# transformers version this box's own unpinned-upper-bound install picks up
# (4.57.6, matching what a real fresh box gets today), Trainer._load_from_
# checkpoint -> _issue_warnings_after_load reads self.model._keys_to_ignore_
# on_save, which FlagEmbedding's EncoderOnlyEmbedderM3Model does not define
# (it is not a transformers.PreTrainedModel subclass, so patching that base
# class does nothing — confirmed by testing both). AttributeError, every
# time, on every resume. A trainer.tokenizer-lands-with-transformers-5-and-
# breaks-save fact is already documented at the top of this file (header
# fact 3); this is the same species one version range earlier, in the load
# path instead of the save path. Downgrading transformers to 4.44.2 does NOT
# fix it either — that version's XLMRobertaModel doesn't accept the `dtype`
# kwarg FlagEmbedding passes, a DIFFERENT crash. The only fix that worked:
# neutralize the specific buggy method, not the model. Applied via a wrapper
# script instead of `-m`, so it fires before FlagEmbedding imports anything.
cat > /opt/train/run_trainer.py <<'PYWRAP'
import transformers.trainer as T
T.Trainer._issue_warnings_after_load = lambda self, load_result: None
import runpy
runpy.run_module("FlagEmbedding.finetune.embedder.encoder_only.m3", run_name="__main__")
PYWRAP

# NPROC>1: wrap the trainer in torchrun, data-parallel across NPROC GPUs.
# per-device batch stays BATCH; effective batch = BATCH * NPROC, so
# steps/warmup are computed off the effective batch, not the per-device one.
# NPROC==1 keeps the exact single-process invocation (OOM loop unchanged).
# Both run the wrapper script above (not `-m FlagEmbedding...` directly) so
# the checkpoint-load patch is in effect whether or not this attempt resumes.
if [ "$NPROC" -gt 1 ]; then
  RUN_PREFIX=("$TORCHRUN" --standalone --nproc_per_node="$NPROC")
else
  RUN_PREFIX=("$PY")
fi
TRAINER_ENTRY=/opt/train/run_trainer.py
EFFECTIVE_BATCH=$((BATCH * NPROC))

# --- checkpointing -------------------------------------------------------
# SAVE_STEPS must be a real number: a fallback that is never exercised is a
# comment, not a fallback (RIG-DOCTRINE #4). Default sized off the CSHL night's
# measured worst case — A10G, batch 4, 384 passage len, 1.22 it/s — so a spot
# reclaim loses at most ~8 minutes: 600 steps * ~0.82s/step ~= 8.2min < 10min.
# Wall-clock per step is roughly batch-invariant for fixed hardware (bigger
# batch = proportionally fewer it/s), so one step-count default travels
# reasonably across the OOM loop's batch halving; override per-box if needed.
SAVE_STEPS=${SAVE_STEPS:-600}
SAVE_TOTAL_LIMIT=${SAVE_TOTAL_LIMIT:-3}
CKPT_SYNC_INTERVAL=${CKPT_SYNC_INTERVAL:-60}
CKPT_S3="s3://$BUCKET/models/$MODEL_NAME/$RUN_ID/checkpoints"
RESUME_FROM=${RESUME_FROM:-}
RESUME_ARG=""
RESUME_STAGE=/opt/train/resume-ckpt
RESUME_CKPT_NAME=""
if [ -n "$RESUME_FROM" ]; then
  echo "[train.sh] RESUME_FROM=$RESUME_FROM — locating latest COMPLETE checkpoint"
  # Highest checkpoint-N is not necessarily complete: the background syncer
  # uploads a multi-GB checkpoint dir over the network, and a spot reclaim (or
  # this box's own OOM/watchdog kill) can land between "checkpoint-N exists as
  # a prefix" and "every file in it finished uploading" — reproduced for real
  # in this lane's acceptance test: killing mid-sync left checkpoint-20 in S3
  # as a lone 658-byte config.json, no weights, no trainer_state.json. Resume
  # must walk newest-to-oldest and skip any checkpoint missing a required
  # file, rather than trusting the highest number. Silently resuming from a
  # truncated checkpoint would either crash (as it did here) or, worse, load
  # partial state without error.
  #
  # REQUIRED_CKPT_FILES was model.safetensors + trainer_state.json only,
  # on the (single-GPU-run) observation that trainer_state.json looked like
  # the last file the Trainer writes locally. The multi-GPU rehearsal
  # (2026-08-20) falsified that: `aws s3 sync` does not upload in write
  # order — it can finish trainer_state.json (900 bytes) while optimizer.pt
  # (4.5GB, the single largest file in the checkpoint) is still mid-transfer.
  # A real checkpoint-20 in that state passed the old two-file check and
  # would have resumed with a missing/reinitialized optimizer, silently.
  # optimizer.pt is now required too — it is the single best proxy for "the
  # whole sync finished" since it is reliably the largest, slowest file.
  REQUIRED_CKPT_FILES="model.safetensors optimizer.pt trainer_state.json"
  CKPT_CANDIDATES=$(aws s3 ls "${RESUME_FROM%/}/" | awk '{print $2}' | sed 's#/$##' | grep '^checkpoint-' | sort -t- -k2 -rn)
  [ -n "$CKPT_CANDIDATES" ] || { echo "[train.sh] RESUME_FROM set but no checkpoint-* found under ${RESUME_FROM%/}/ — refusing"; exit 1; }
  for c in $CKPT_CANDIDATES; do
    COMPLETE=1
    for f in $REQUIRED_CKPT_FILES; do
      # `|| true` is load-bearing: under `set -o pipefail` (part of this
      # script's own `set -euo pipefail`), `aws s3 ls <missing-key> | wc -l`
      # reports ls's nonzero exit even though wc -l itself succeeds, and a
      # failing command substitution in a plain assignment kills the whole
      # script under `set -e`. Identical bug class to CSHL-CPT-REPORT.md's
      # AZ-failover post-mortem, freshly reproduced here while testing THIS
      # fix the first time it was written.
      HAS=$(aws s3 ls "${RESUME_FROM%/}/$c/$f" 2>/dev/null | wc -l) || true
      [ "${HAS:-0}" -ge 1 ] || { COMPLETE=0; break; }
    done
    [ "$COMPLETE" -eq 1 ] && { RESUME_CKPT_NAME="$c"; break; }
    echo "[train.sh] $c is incomplete (missing one of: $REQUIRED_CKPT_FILES) — skipping, trying older"
  done
  [ -n "$RESUME_CKPT_NAME" ] || { echo "[train.sh] RESUME_FROM set but no COMPLETE checkpoint-* found under ${RESUME_FROM%/}/ — refusing"; exit 1; }
  echo "[train.sh] resuming from $RESUME_CKPT_NAME (verified complete)"
  rm -rf "$RESUME_STAGE"; mkdir -p "$RESUME_STAGE/$RESUME_CKPT_NAME"
  aws s3 sync "${RESUME_FROM%/}/$RESUME_CKPT_NAME/" "$RESUME_STAGE/$RESUME_CKPT_NAME/" --only-show-errors
  echo "[train.sh] staged $RESUME_CKPT_NAME ($(du -sh "$RESUME_STAGE/$RESUME_CKPT_NAME" | cut -f1)) from $RESUME_FROM"
  if grep -q -- '--resume_from_checkpoint' /opt/flagembed-help.txt 2>/dev/null; then
    RESUME_ARG="--resume_from_checkpoint $OUT/$RESUME_CKPT_NAME"
    echo "[train.sh] installed CLI exposes --resume_from_checkpoint — passing it explicitly"
  else
    echo "[train.sh] no --resume_from_checkpoint in --help — relying on the Trainer's own last-checkpoint-in-output_dir detection (output_dir seeded, not wiped, for this attempt only)"
  fi
fi

# Background syncer: mirrors any checkpoint-*/ that lands under $OUT to S3 as
# training runs, since the box's disk dies with the box. This is what makes
# SAVE_STEPS actually protective rather than a local-only safety net.
(
  while true; do
    sleep "$CKPT_SYNC_INTERVAL"
    [ -d "$OUT" ] && aws s3 sync "$OUT" "$CKPT_S3/" --exclude '*' --include 'checkpoint-*/**' --only-show-errors 2>/dev/null
  done
) &
SYNC_PID=$!
trap 'kill $SYNC_PID 2>/dev/null || true' EXIT

RESUMED_ONCE=""
T0=$(date +%s)
while true; do
  EFFECTIVE_BATCH=$((BATCH * NPROC))
  STEPS_PER_EPOCH=$(( (N_PAIRS + EFFECTIVE_BATCH - 1) / EFFECTIVE_BATCH ))
  WARMUP=$(( STEPS_PER_EPOCH / 10 )); [ "$WARMUP" -lt 1 ] && WARMUP=1
  echo "[train.sh] attempt: nproc=$NPROC per_device_batch=$BATCH effective_batch=$EFFECTIVE_BATCH warmup_steps=$WARMUP gradient_checkpointing=${CKPT_FLAG:+on}${CKPT_FLAG:-off} save_steps=$SAVE_STEPS"
  rm -rf "$OUT"
  if [ -n "$RESUME_CKPT_NAME" ] && [ -z "$RESUMED_ONCE" ]; then
    mkdir -p "$OUT"
    cp -r "$RESUME_STAGE/$RESUME_CKPT_NAME" "$OUT/$RESUME_CKPT_NAME"
    RESUMED_ONCE=1
    echo "[train.sh] seeded $OUT/$RESUME_CKPT_NAME for resume"
  else
    RESUME_ARG=""   # only attempt resume once; a later OOM retry starts clean
  fi
  set +e
  "${RUN_PREFIX[@]}" "$TRAINER_ENTRY" \
    --model_name_or_path "$BASE_MODEL" \
    --cache_dir /opt/train/hf-cache \
    --train_data train.jsonl \
    --cache_path /opt/train/data-cache \
    --train_group_size $GROUP_SIZE \
    --query_max_len $QUERY_MAX_LEN \
    --passage_max_len $PASSAGE_MAX_LEN \
    --pad_to_multiple_of 8 \
    --knowledge_distillation False \
    --unified_finetuning False \
    --use_self_distill False \
    --output_dir $OUT \
    --learning_rate ${LR:-1e-5} \
    --bf16 \
    --num_train_epochs $EPOCHS \
    --per_device_train_batch_size $BATCH \
    $CKPT_FLAG \
    --dataloader_drop_last True \
    --warmup_steps $WARMUP \
    --logging_steps 10 \
    --save_steps $SAVE_STEPS \
    --save_total_limit $SAVE_TOTAL_LIMIT \
    $RESUME_ARG \
    --temperature 0.02 \
    --sentence_pooling_method cls \
    --normalize_embeddings True \
    2>&1 | tee /opt/train/train.log
  EXIT=${PIPESTATUS[0]}
  set -e
  [ "$EXIT" -eq 0 ] && break
  if grep -qiE "out of memory|CUDA error: out of memory|OutOfMemoryError" /opt/train/train.log; then
    if [ -z "$CKPT_FLAG" ] && [ "$BATCH" -le 1 ]; then
      echo "[train.sh] OOM at batch=1 without checkpointing — enabling gradient_checkpointing"
      CKPT_FLAG="--gradient_checkpointing"; continue
    elif [ "$BATCH" -le 1 ]; then
      echo "[train.sh] OOM at batch=1 even with checkpointing — giving up"; exit "$EXIT"
    fi
    BATCH=$((BATCH / 2)); echo "[train.sh] OOM — halving batch to $BATCH"; continue
  fi
  echo "[train.sh] training failed (non-OOM)"; exit "$EXIT"
done
T1=$(date +%s)
echo "[train.sh] wall-clock: $((T1 - T0))s EXIT=$EXIT final_batch=$BATCH gradient_checkpointing=${CKPT_FLAG:+on}${CKPT_FLAG:-off}"
kill $SYNC_PID 2>/dev/null || true
aws s3 sync "$OUT" "$CKPT_S3/" --exclude '*' --include 'checkpoint-*/**' --only-show-errors 2>/dev/null || true
echo "[train.sh] final checkpoint sync done"

# 4. Write the SBERT pooling config into the checkpoint. NON-OPTIONAL: the
#    trainer saves none, and a bare SentenceTransformer(ckpt) then silently
#    defaults to MEAN pooling. NSR measured cosine 0.76 between the mean-pooled
#    and the model's real CLS-pooled output — i.e. a wrong-but-plausible model.
$PY - <<PY
import json, os
CKPT = "$OUT"
os.makedirs(f'{CKPT}/1_Pooling', exist_ok=True)
json.dump([{"idx":0,"name":"0","path":"","type":"sentence_transformers.models.Transformer"},
           {"idx":1,"name":"1","path":"1_Pooling","type":"sentence_transformers.models.Pooling"}],
          open(f'{CKPT}/modules.json','w'))
json.dump({"word_embedding_dimension":1024,"pooling_mode_cls_token":True,"pooling_mode_mean_tokens":False,
           "pooling_mode_max_tokens":False,"pooling_mode_mean_sqrt_len_tokens":False,
           "pooling_mode_weightedmean_tokens":False,"pooling_mode_lasttoken":False},
          open(f'{CKPT}/1_Pooling/config.json','w'))
json.dump({"max_seq_length":$PASSAGE_MAX_LEN,"do_lower_case":False}, open(f'{CKPT}/sentence_bert_config.json','w'))
print("[train.sh] wrote SBERT pooling config (CLS)")
PY

# 5. Rehearsal only: sanity-embed the slice's own passages — dims, unit norm,
#    no NaN, and a throughput number for the Phase-2 estimate. No DB needed.
if [ "$MODE" = rehearse ]; then
  $PY - <<PY
import json, time, numpy as np
from sentence_transformers import SentenceTransformer
texts = []
for line in open('/opt/train/train.jsonl'):
    o = json.loads(line)
    texts.extend(o['pos'][:1]);  texts.append(o['query'])
    if len(texts) >= 2000: break
t0 = time.time()
m = SentenceTransformer("$OUT")
e = np.asarray(m.encode(texts, normalize_embeddings=True, show_progress_bar=False))
dt = time.time() - t0
print(f"[rehearsal-embed] n={len(texts)} dims={e.shape[1]} nan={bool(np.isnan(e).any())} "
      f"norm_mean={np.linalg.norm(e,axis=1).mean():.4f} rows_per_s={len(texts)/dt:.1f}")
PY
fi

# 5b. Embed the frozen benchmark's queries with the fresh checkpoint, HERE, while
#     the model is already resident in GPU memory. This is what takes the serve
#     box off the eval critical path: without it, scoring our own arm needs a TEI
#     endpoint stood up, warmed and healthy before a single query can be encoded.
#     With it, the scorer just reads a jsonl. Costs seconds on a box we are
#     already paying for.
if aws s3 cp "s3://$BUCKET/eval/$EVAL_VERSION/queries.jsonl" /opt/train/queries.jsonl 2>/dev/null; then
  $PY - <<'QEMB'
import json, os, numpy as np
from sentence_transformers import SentenceTransformer
qs = [json.loads(l) for l in open('/opt/train/queries.jsonl') if l.strip()]
m = SentenceTransformer(os.environ['OUT_DIR'])
texts = [q['text'][:2000] for q in qs]
# normalize=True: our arm is a cosine model (registry metric 'cosine') and the
# corpus side is embedded through TEI, which normalizes. Both sides must agree.
E = np.asarray(m.encode(texts, normalize_embeddings=True, batch_size=128, show_progress_bar=False))
with open('/opt/train/qemb.jsonl', 'w') as f:
    for q, v in zip(qs, E):
        f.write(json.dumps({"qid": q["qid"], "v": [round(float(x), 6) for x in v]}) + "\n")
print(f"[train.sh] embedded {len(qs)} eval queries, dim {E.shape[1]}")
QEMB
  aws s3 cp /opt/train/qemb.jsonl "s3://$BUCKET/eval/$EVAL_VERSION/qemb-$RUN_ID.jsonl" || true
else
  echo "[train.sh] no frozen queries at s3://$BUCKET/eval/$EVAL_VERSION/queries.jsonl - skipping query embed"
fi

# 6. Upload weights + logs. Weights FIRST: NSR's reranker box terminated with a
#    clean 2,558 s training run and no weights, because the upload was last.
aws s3 cp --recursive "$OUT" "s3://$BUCKET/models/$MODEL_NAME/$RUN_ID/final/"
aws s3 cp /opt/train/train.log "s3://$BUCKET/logs/cshl-train-$RUN_ID-inner.log"
echo "[train.sh] done. weights: s3://$BUCKET/models/$MODEL_NAME/$RUN_ID/final/"
