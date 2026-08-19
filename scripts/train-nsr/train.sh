#!/bin/bash
# train-nsr box-side script — runs on the g6.xlarge EC2 box launched by
# launch.sh (AMI ami-012ba162b9cd2729c, 44b's PyTorch DLAMI). Installs
# FlagEmbedding, trains nsr-encoder-bge-m3 on a converted jsonl slice pulled
# from S3, then (MODE=train only) candidate-embeds the frozen corpus + eval
# queries so LANE-EVAL's scripts/eval/score.mjs can score arm D. One boot.
#
# Every line below was verified BY HAND over an SSM Session Manager shell on
# a live box (i-02e4ba1beef085fd5, 2026-08-17 00:52-01:11) after 4 automated
# boot/fail/guess cycles wasted ~$0.51 on blind iteration — non-negotiable #2
# ("use the box's actual flags, don't guess") applied to the whole box, not
# just the CLI flags. Three environment facts this AMI required, found only
# by getting a real shell:
#   1. Python with torch is /opt/pytorch/bin/python3 (a dedicated venv,
#      Python 3.12) — NOT the system /usr/bin/python3 (Python 3.10, no ML
#      libs at all).
#   2. transformer_engine (pre-installed, imported transitively by
#      peft->transformers.Trainer) does a raw ctypes dlopen of
#      libcudnn_graph.so.9, which exists under
#      .../site-packages/nvidia/cudnn/lib but isn't on the default loader
#      path. LD_LIBRARY_PATH must include every nvidia/*/lib dir under
#      /opt/pytorch's site-packages, every invocation.
#   3. FlagEmbedding 1.4.0's finetune trainer (AbsTrainer._save) references
#      the deprecated Trainer.tokenizer attribute, which transformers 5.x
#      (the newest release pip installs by default) no longer backs —
#      AttributeError at the SAVE step, after a full successful training
#      run. Pin transformers to FlagEmbedding's own declared floor
#      (>=4.44.2,<5) to get a version where that attribute still exists.
set -euo pipefail
: "${MODE:?}" "${TRAIN_NAME:?}" "${RUN_ID:?}" "${BUCKET:?}" "${DATABASE_URL:?}"
echo "[train.sh] MODE=$MODE TRAIN_NAME=$TRAIN_NAME RUN_ID=$RUN_ID"

PY=/opt/pytorch/bin/python3
SP=/opt/pytorch/lib/python3.12/site-packages
export LD_LIBRARY_PATH="$(find "$SP/nvidia" -maxdepth 2 -type d -name lib | tr '\n' ':')"

# 1. Install. Base FlagEmbedding (no [finetune] extra — its flash-attn/
# deepspeed deps don't build on this box and encoder_only.m3's code path
# never imports either, grepped and confirmed), then pin transformers <5
# (see header). psycopg2-binary for the DB steps below.
$PY -m pip install -U FlagEmbedding psycopg2-binary 2>&1 | tail -60
$PY -m pip install "transformers>=4.44.2,<5" 2>&1 | tail -20
echo "[train.sh] --help for the installed FlagEmbedding version (non-negotiable #2 — use ITS flags):"
$PY -m FlagEmbedding.finetune.embedder.encoder_only.m3 --help 2>&1 | tee /opt/flagembed-help.txt || true

# 2. Pull the converted training slice
mkdir -p /opt/train && cd /opt/train
aws s3 cp "s3://$BUCKET/train/$TRAIN_NAME/train.jsonl" train.jsonl
N_PAIRS=$(wc -l < train.jsonl)
echo "[train.sh] $N_PAIRS training pairs in $TRAIN_NAME"

# 3. Train (dense-only bge-m3 finetune — LANE-TRAIN non-negotiable #2).
#    Phase-1 speed config (lead, commit 0ac279c): group 8, query_max_len 128,
#    passage_max_len 256, bf16 (not fp16), gradient checkpointing OFF unless
#    OOM. Batch search starts at 16, not 64: measured by hand on this exact
#    config (999 pairs, group 8, query 128/passage 256, L40S 46GB) — 64 and
#    32 OOM immediately (even with --sub_batch_size 8, which barely moved
#    the 43-44GB peak — the M3 forward pass computes dense+sparse+colbert
#    unconditionally regardless of --unified_finetuning, so the ceiling is
#    lower than a dense-only run would suggest), 24 OOMs, 16 is clean
#    (14.7 pairs/s measured, sustained ~1.27 it/s mid-run) and beats 8+
#    checkpointing's 11.1 pairs/s. This ceiling is set by group_size ×
#    seq_len, not total pair count, so it should hold for Phase 2's larger
#    real run too — re-verify if query/passage_max_len ever change.
#    --overwrite_output_dir does not exist in this installed version's
#    TrainingArguments (confirmed via --help) — rm -rf instead. Likewise
#    --warmup_ratio doesn't exist; --warmup_steps does, computed below.
OUT=/opt/train/out
EPOCHS=${EPOCHS:-1}
BATCH=${BATCH:-16}
CKPT_FLAG=""
T0=$(date +%s)
while true; do
  STEPS_PER_EPOCH=$(( (N_PAIRS + BATCH - 1) / BATCH ))
  WARMUP=$(( STEPS_PER_EPOCH / 10 ))
  [ "$WARMUP" -lt 1 ] && WARMUP=1
  echo "[train.sh] attempt: batch=$BATCH warmup_steps=$WARMUP gradient_checkpointing=${CKPT_FLAG:+on}${CKPT_FLAG:-off}"
  rm -rf "$OUT"
  set +e
  $PY -m FlagEmbedding.finetune.embedder.encoder_only.m3 \
    --model_name_or_path BAAI/bge-m3 \
    --cache_dir /opt/train/hf-cache \
    --train_data train.jsonl \
    --cache_path /opt/train/data-cache \
    --train_group_size 8 \
    --query_max_len 128 \
    --passage_max_len 256 \
    --pad_to_multiple_of 8 \
    --knowledge_distillation False \
    --unified_finetuning False \
    --use_self_distill False \
    --output_dir $OUT \
    --learning_rate 1e-5 \
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
      echo "[train.sh] OOM at batch=1 without checkpointing — enabling gradient_checkpointing, retrying at batch=1"
      CKPT_FLAG="--gradient_checkpointing"; continue
    elif [ "$BATCH" -le 1 ]; then
      echo "[train.sh] OOM at batch=1 even with checkpointing — giving up"; exit "$EXIT"
    fi
    BATCH=$((BATCH / 2))
    echo "[train.sh] OOM detected — halving batch to $BATCH, retrying"
    continue
  fi
  echo "[train.sh] training failed (non-OOM) — not proceeding to embed"
  exit "$EXIT"
done
T1=$(date +%s)
echo "[train.sh] training wall-clock: $((T1 - T0))s EXIT=$EXIT final_batch=$BATCH gradient_checkpointing=${CKPT_FLAG:+on}${CKPT_FLAG:-off}"

# 4. Rehearsal only (LANE-TRAIN Phase 1): sanity-embed a 5,000-row corpus
#    slice, confirm dims 1024 / unit norm / no NaN. No DB write.
#    Writes the SBERT pooling config first — the trainer's saved checkpoint
#    carries none, and a bare `SentenceTransformer(ckpt)` silently defaults
#    to MEAN pooling (confirmed 2026-08-17, cosine 0.76 vs the model's real
#    CLS-pooled output — measured while building Phase 3's candidate-embed).
#    Without this, this whole sanity check validates shape, not correctness.
if [ "$MODE" = rehearse ]; then
  $PY - <<PY
import json, os, numpy as np, psycopg2
from sentence_transformers import SentenceTransformer

CKPT = os.environ.get('CKPT', '$OUT')
os.makedirs(f'{CKPT}/1_Pooling', exist_ok=True)
with open(f'{CKPT}/modules.json', 'w') as f:
    json.dump([
        {"idx": 0, "name": "0", "path": "", "type": "sentence_transformers.models.Transformer"},
        {"idx": 1, "name": "1", "path": "1_Pooling", "type": "sentence_transformers.models.Pooling"},
    ], f)
with open(f'{CKPT}/1_Pooling/config.json', 'w') as f:
    json.dump({
        "word_embedding_dimension": 1024,
        "pooling_mode_cls_token": True,
        "pooling_mode_mean_tokens": False,
        "pooling_mode_max_tokens": False,
        "pooling_mode_mean_sqrt_len_tokens": False,
        "pooling_mode_weightedmean_tokens": False,
        "pooling_mode_lasttoken": False,
    }, f)
with open(f'{CKPT}/sentence_bert_config.json', 'w') as f:
    json.dump({"max_seq_length": 256, "do_lower_case": False}, f)

conn = psycopg2.connect(os.environ['DATABASE_URL'])
cur = conn.cursor()
cur.execute("""
  SELECT left(trim(coalesce(title,'') || E'\n\n' || coalesce(abstract,'')), 2000)
    FROM nsr
   WHERE length(regexp_replace(coalesce(title,'') || coalesce(abstract,''), '\\\\s+', '', 'g')) >= 20
   LIMIT 5000
""")
texts = [r[0] for r in cur.fetchall()]
t0 = __import__('time').time()
model = SentenceTransformer(CKPT)
emb = np.asarray(model.encode(texts, normalize_embeddings=True, show_progress_bar=False))
dt = __import__('time').time() - t0
print(f"[rehearsal-embed] n={len(texts)} dims={emb.shape[1]} nan={bool(np.isnan(emb).any())} "
      f"norm_mean={np.linalg.norm(emb, axis=1).mean():.4f} rows_per_s={len(texts)/dt:.1f}")
PY
fi

# 5. Full run only (LANE-TRAIN Phase 3): candidate-embed the frozen 277,068-row
#    corpus + LANE-EVAL's frozen queries with the trained checkpoint (sql/
#    25-candidate.sql applied 2026-08-17; nsr_eval_queries schema confirmed
#    live: qid, family, text, embedding, embedded_at — matches sql/24-eval.sql).
#    Pulled fresh from S3 HERE, not baked in at boot: this step runs 40+ min
#    after the box booted (after training), so a fix pushed to S3 while
#    training is still in flight lands here without a relaunch.
if [ "$MODE" = train ]; then
  aws s3 cp "s3://$BUCKET/candidate-embed.py" candidate-embed.py
  CKPT=$OUT RUN_ID=$RUN_ID DATABASE_URL=$DATABASE_URL $PY candidate-embed.py
fi

# 6. Upload weights + logs
aws s3 cp --recursive "$OUT" "s3://$BUCKET/models/nsr-encoder-bge-m3/$RUN_ID/final/"
aws s3 cp /opt/train/train.log "s3://$BUCKET/logs/nsr-train-$RUN_ID-inner.log"
echo "[train.sh] done. weights: s3://$BUCKET/models/nsr-encoder-bge-m3/$RUN_ID/final/"
