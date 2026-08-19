# train-nsr — fine-tune `nsr-encoder-bge-m3`

Rig for LANE-TRAIN (`docs/prompts/LANE-TRAIN.md`). Copies the shape of
`scripts/embed-nsr/` (same IAM role `nsr-embed`, security group, SSM param,
S3 bucket `nsr-embed-v2`, self-terminating g6e.xlarge) but runs the
FlagEmbedding finetuner instead of TEI.

## Pinned reference (read 2026-08-17, from GitHub)

- Repo: `FlagOpen/FlagEmbedding`, branch `master`, commit
  `292ad785dea715f8cd509b8177f6e48618e6b137` (2026-08-14T06:16:02Z).
- Docs read: `examples/finetune/embedder/README.md`
  (https://raw.githubusercontent.com/FlagOpen/FlagEmbedding/master/examples/finetune/embedder/README.md)
  and `examples/finetune/embedder/encoder_only/m3.sh`
  (https://raw.githubusercontent.com/FlagOpen/FlagEmbedding/master/examples/finetune/embedder/encoder_only/m3.sh).
  There is no `encoder_only/m3/README.md` — the finetune arg docs live in the
  top-level README; the working example is the `.sh` file next to `base.sh`
  in `encoder_only/`.
- **Module** (non-negotiable #2, exact): `FlagEmbedding.finetune.embedder.encoder_only.m3`.
  Single-GPU invocation (our box is 1×L40S, no `torchrun`/multi-node needed):
  ```
  python -m FlagEmbedding.finetune.embedder.encoder_only.m3 <args>
  ```
- **Data format** (jsonl, one object per line):
  `{"query": str, "pos": List[str], "neg": List[str], "pos_scores": List[int],
  "neg_scores": List[int], "prompt": str, "type": str}`. We only ever populate
  `query`/`pos`/`neg` — no distillation scores, no ICL type.
- **Dense-only flags** (brief's rule: no sparse/colbert unified finetuning, no
  self-distill — this is what separates our run from the `m3.sh` example,
  which defaults `unified_finetuning True` / `use_self_distill True` /
  `kd_loss_type m3_kd_loss`):
  ```
  --knowledge_distillation False
  --unified_finetuning False
  --use_self_distill False
  ```
  (`kd_loss_type`, `fix_encoder`, `self_distill_start_step`, `colbert_dim` are
  unified/self-distill-only args — omitted, they're no-ops with
  `unified_finetuning False`.)
- **Other flags used, from the top-level README's arg list.** Values below
  are the **Phase-1 speed config** (lead, commit `0ac279c`, supersedes the
  Phase-0 draft numbers of query 256 / passage 512 / fp16 / checkpointing on):
  `--model_name_or_path BAAI/bge-m3`, `--train_data <converted jsonl>`,
  `--train_group_size 8` (unchanged — do not shrink, it's the mined shape),
  `--query_max_len 128`, `--passage_max_len 256` (keyword abstracts / EXFOR
  titles are short — the doc's first 256 tokens carry title + abstract head),
  `--pad_to_multiple_of 8`, `--learning_rate 1e-5`, `--bf16` (not `--fp16`),
  `--num_train_epochs` (1 for rehearsal and Phase 2's first run),
  `--per_device_train_batch_size` (**16, measured** — see box verification
  below; `train.sh` still loops start-16/halve-on-OOM/checkpoint-as-last-resort
  for robustness against Phase 2's real data having a different memory
  profile), `--dataloader_drop_last True`, `--warmup_steps` (**not
  `--warmup_ratio`** — doesn't exist in the installed TrainingArguments,
  see below; computed as 10% of steps-per-epoch), `--logging_steps 10`,
  `--save_steps` (Phase 2: 25% of an epoch's steps, computed from the
  rehearsal's measured steps/s; rehearsal itself doesn't need a mid-run
  checkpoint), `--temperature 0.02`, `--sentence_pooling_method cls`,
  `--normalize_embeddings True`, `--output_dir` (**no
  `--overwrite_output_dir`** — doesn't exist either; `train.sh` does `rm -rf`
  before each attempt instead).
- `--negatives_cross_device` and `--deepspeed ../../ds_stage0.json` appear in
  the multi-GPU example — **not used**: single-GPU, no cross-device negatives
  to share.
- Install: **`pip install -U FlagEmbedding "transformers>=4.44.2,<5"
  psycopg2-binary`** (base FlagEmbedding, no `[finetune]` extra — its
  `deepspeed`/`flash-attn` deps don't build here and `encoder_only/m3`'s
  source + its abc base classes have zero references to either, grepped and
  confirmed; **then pin transformers below 5** — pip installs 5.15.0 by
  default, which breaks `FlagEmbedding`'s finetune trainer, see box
  verification below).

## Box verification (2026-08-17, SSM Session Manager, i-02e4ba1beef085fd5)

Four automated boot/fail/relaunch cycles (~$0.51, see LANE-TRAIN.md REPORT)
were guessing at an environment nobody had actually looked inside. Got a real
shell instead (`aws ssm start-session --target <id>`, or `send-command` for
scripted round-trips) and found three AMI-specific facts non-negotiable #2's
"use the box's real flags" applies to as much as the CLI args:

1. **Python**: `/opt/pytorch/bin/python3` (3.12, has torch) — **not**
   `/usr/bin/python3` (3.10, system Python, no ML libs at all). The system
   `python3` is what a bare `python3 -m pip install ...` targets by default;
   using it silently installs into the wrong interpreter.
2. **`LD_LIBRARY_PATH`**: `transformer_engine` (pre-installed on this AMI,
   pulled in transitively via `peft` → `transformers.Trainer`) does a raw
   `ctypes.CDLL` load of `libcudnn_graph.so.9`. The file exists under
   `.../site-packages/nvidia/cudnn/lib` but isn't on the default loader path
   — `import FlagEmbedding` (which imports `transformers.TrainingArguments`)
   fails with `OSError: libcudnn_graph.so.9: cannot open shared object file`
   unless `LD_LIBRARY_PATH` includes every `nvidia/*/lib` dir under
   `/opt/pytorch`'s site-packages. `train.sh` sets this once at the top via
   `find ... -name lib`.
3. **transformers version**: pip's default install pulled `transformers
   5.15.0`. Training completed a full epoch cleanly, then crashed at the
   SAVE step: `AttributeError: 'EncoderOnlyEmbedderM3Trainer' object has no
   attribute 'tokenizer'` — FlagEmbedding 1.4.0's custom trainer references
   the now-removed `Trainer.tokenizer` (renamed `processing_class` partway
   through the 4.x→5.x transition, then dropped). Pinning to FlagEmbedding's
   own declared floor (`transformers>=4.44.2,<5`, i.e. `4.57.6` at time of
   testing) fixed it — full run + save succeeded.
4. **Batch ceiling, measured by hand** on this exact config (999 pairs,
   group 8, query 128 / passage 256, bf16, L40S 46GB): 64 and 32 OOM
   immediately; **32 with `--sub_batch_size 8` also OOM'd, barely moving the
   ~44GB peak** — the M3 forward pass computes dense+sparse+colbert
   unconditionally (confirmed in `modeling.py`: `encode()` always returns all
   three), so `--unified_finetuning False` reduces the LOSS terms, not the
   memory footprint; 24 OOMs; **16 is clean** — 14.7 pairs/s sustained
   (`train_samples_per_second`), ~1.27 it/s mid-run — and beats 8 +
   `--gradient_checkpointing`'s 11.1 pairs/s (checkpointing's recompute cost
   outweighs the smaller batch). This ceiling is set by `group_size ×
   seq_len`, not total pair count, so it should hold for Phase 2's larger
   real run too.

## Files

- `launch.sh` — EC2 launcher, adapted from `scripts/embed-nsr/launch.sh`.
  `MODE=rehearse|train` selects the box-side behavior in `train.sh`.
- `train.sh` — box-side: installs FlagEmbedding, pulls the training jsonl
  from `s3://nsr-embed-v2/train/<name>/`, runs the finetuner, then (Phase 3)
  candidate-embeds the frozen corpus + eval queries with the trained
  checkpoint, uploads weights + logs to S3, terminates.
- `to-flag.mjs` — converts a LANE-TRIPLETS record
  (`{"query","positive":{"slug","title","abstract"},"negatives":[{...}],"meta"}`)
  to FlagEmbedding's `{"query","pos":[],"neg":[]}`. Local/laptop script — pure
  jsonl-to-jsonl text transform, no DB, no model inference, no S3 (matches the
  "DB/S3-only, nothing model-side" laptop rule; this is neither, it's a text
  reshape). Drops pairs with < 4 negatives. `--limit N` for rehearsal slices.
- `upload-slice.sh` — `aws s3 sync` a local converted jsonl dir to
  `s3://nsr-embed-v2/train/<name>/`.

## IAM verdict (Phase 0, read-only check — no changes applied)

`aws iam get-role-policy --role-name nsr-embed --policy-name read-dburl`,
run 2026-08-17:

```json
{
  "Statement": [
    {"Effect": "Allow", "Action": "ssm:GetParameter", "Resource": "arn:...:parameter/nsr/embed/dburl"},
    {"Effect": "Allow", "Action": "s3:GetObject", "Resource": "arn:aws:s3:::nsr-embed-v2/*"},
    {"Effect": "Allow", "Action": "s3:PutObject", "Resource": "arn:aws:s3:::nsr-embed-v2/logs/*"}
  ]
}
```

- **Read `s3://nsr-embed-v2/train/*`: already covered.** `s3:GetObject` is
  granted on `nsr-embed-v2/*` (whole-bucket wildcard) — no delta needed.
- **Write `s3://nsr-embed-v2/models/*`: NOT covered.** `s3:PutObject` is
  scoped to `logs/*` only. `aws s3 ls s3://nsr-embed-v2/models/` and
  `s3://nsr-embed-v2/train/` both return empty (prefixes don't exist yet,
  bucket only has `worker.mjs` and `logs/`).
- **Policy delta needed before Phase 2/3 can upload weights** (NOT applied —
  read-only per Phase 0 instructions):
  ```json
  {
    "Effect": "Allow",
    "Action": "s3:PutObject",
    "Resource": "arn:aws:s3:::nsr-embed-v2/models/*"
  }
  ```
  `launch.sh` below applies this itself at launch time via the same idempotent
  `put-role-policy` refresh the embed rig already does on every run (it does
  not run now, and did not run during Phase 0).
- HF token: not needed. `BAAI/bge-m3` is a public (non-gated) HF model — the
  embed rig's TEI container already pulls it with no token. No SSM param
  created.
