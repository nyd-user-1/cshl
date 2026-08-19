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
MODEL_NAME=${MODEL_NAME:-rxiv-encoder-bge-m3}
BASE_MODEL=${BASE_MODEL:-BAAI/bge-m3}
EPOCHS=${EPOCHS:-1}
BATCH=${BATCH:-8}
GROUP_SIZE=${GROUP_SIZE:-8}
QUERY_MAX_LEN=${QUERY_MAX_LEN:-128}
PASSAGE_MAX_LEN=${PASSAGE_MAX_LEN:-512}
echo "[train.sh] MODE=$MODE TRAIN_NAME=$TRAIN_NAME RUN_ID=$RUN_ID base=$BASE_MODEL q=$QUERY_MAX_LEN p=$PASSAGE_MAX_LEN group=$GROUP_SIZE"

PY=/opt/pytorch/bin/python3
SP=/opt/pytorch/lib/python3.12/site-packages
export LD_LIBRARY_PATH="$(find "$SP/nvidia" -maxdepth 2 -type d -name lib | tr '\n' ':')"

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
OUT=/opt/train/out
CKPT_FLAG=""
T0=$(date +%s)
while true; do
  STEPS_PER_EPOCH=$(( (N_PAIRS + BATCH - 1) / BATCH ))
  WARMUP=$(( STEPS_PER_EPOCH / 10 )); [ "$WARMUP" -lt 1 ] && WARMUP=1
  echo "[train.sh] attempt: batch=$BATCH warmup_steps=$WARMUP gradient_checkpointing=${CKPT_FLAG:+on}${CKPT_FLAG:-off}"
  rm -rf "$OUT"
  set +e
  $PY -m FlagEmbedding.finetune.embedder.encoder_only.m3 \
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
    --save_steps ${SAVE_STEPS:-999999} \
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

# 6. Upload weights + logs. Weights FIRST: NSR's reranker box terminated with a
#    clean 2,558 s training run and no weights, because the upload was last.
aws s3 cp --recursive "$OUT" "s3://$BUCKET/models/$MODEL_NAME/$RUN_ID/final/"
aws s3 cp /opt/train/train.log "s3://$BUCKET/logs/cshl-train-$RUN_ID-inner.log"
echo "[train.sh] done. weights: s3://$BUCKET/models/$MODEL_NAME/$RUN_ID/final/"
