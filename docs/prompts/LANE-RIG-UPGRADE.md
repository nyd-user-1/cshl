# LANE-RIG-UPGRADE — append-only status log

Branch: `lane/rig-upgrade`. Worktree: `../cshl-rig-upgrade`. Never merges — Brendan
or the lead merges after the 40k run completes. Budget: hard cap $1.50 AWS,
rehearsals only.

---

## 2026-08-19T00:00Z — start

Read `docs/RIG-DOCTRINE.md`, `docs/ORCHESTRATION-DOCTRINE.md`,
`scripts/train/launch.sh`, `scripts/train/train.sh`, and the "Training — what
the hardware actually allowed" / "Two rig bugs found by the capacity failure"
sections of `docs/CSHL-CPT-REPORT.md`.

Checked for a live train box before touching anything:
`aws ec2 describe-instances --filters Name=instance-state-name,Values=running,pending`
→ only `44b-web`, `cshl-serve-cshl`, `nsr-serve` (t4g/t3, non-GPU). No GPU train
box in flight at start.

**Isolation beyond the worktree.** `scripts/train/launch.sh` uploads
`train.sh` to a single un-namespaced key, `s3://$BUCKET/train.sh`, and its IAM
step (`put-role-policy --policy-name read-dburl`) *replaces* (not merges) the
named policy on the shared `cshl-embed` role. Rehearsing against the
production `BUCKET=cshl-embed-rxiv` / `ROLE=cshl-embed` would risk clobbering
`train.sh` out from under a real run that boots mid-rehearsal, or narrowing
the shared role's S3 grant to a test bucket. So all rehearsals in this lane
run against a **fully separate, isolated stack**, created fresh and touching
nothing shared:

- S3 bucket `cshl-embed-rxiv-rigtest` (new, empty, mine).
- IAM role + instance profile `cshl-rig-test` (new), policy `rigtest-access`
  scoped only to that bucket, plus read-only `ssm:GetParameter` on the
  existing `/cshl/embed/dburl` param (harmless reuse — same read grant the
  production role already has, nothing narrowed).
- Reused read-only: security group `cshl-embed-sg` (egress-only, lookup only,
  no mutation), the PyTorch DLAMI id.
- Rehearsal training slice: first 400 pairs of `train/parity/train.jsonl`
  (real corpus, real triplets), uploaded to
  `s3://cshl-embed-rxiv-rigtest/train/rigckpt/train.jsonl` with a manifest
  asserting inherited disjointness (subset of an already-disjoint set).

The committed scripts' defaults are untouched (`BUCKET=cshl-embed-rxiv`,
`ROLE=cshl-embed`) — only my manual invocations override them for rehearsal.

Plan: three upgrades in priority order (checkpointing, multi-GPU/torchrun,
instance-type-menu failover), DRYRUN=1 first for every AWS-touching change,
real evidence for checkpointing via one isolated rehearsal box.

## 2026-08-19T00:20Z — upgrade 1 (checkpointing) + upgrade 2 (multi-GPU) implemented

**train.sh:**
- `SAVE_STEPS` real default (600), computed from the CSHL night's measured
  worst-case throughput (A10G, batch 4, 1.22 it/s) so a spot reclaim loses
  ≤~8 min. `SAVE_TOTAL_LIMIT` (default 3) caps local disk.
- Background syncer (`aws s3 sync ... --include 'checkpoint-*/**'` every
  `CKPT_SYNC_INTERVAL`s, default 60) mirrors checkpoints to
  `s3://$BUCKET/models/$MODEL_NAME/$RUN_ID/checkpoints/` as they land, plus a
  final sync after the training loop exits (belt-and-suspenders for the last
  partial interval) and on EXIT via trap.
- `RESUME_FROM=<s3 prefix>` knob: finds the highest `checkpoint-N` under the
  prefix, stages it locally, seeds `$OUT` with it on the first attempt only
  (later OOM-retry attempts inside the same box start clean — resuming a
  batch-halved retry from a full-batch checkpoint is not attempted). Passes
  `--resume_from_checkpoint` explicitly IF the installed CLI's `--help`
  advertises it, else relies on the Trainer's own last-checkpoint-in-
  output_dir auto-detection (output_dir is seeded, not wiped, that attempt).
  Which path is live is determined empirically on the box, not assumed —
  see the rehearsal evidence below.
- **Bug found while wiring this up, fixed before it shipped:** the IAM
  policy `launch.sh` sets on the training role only grants `s3:GetObject`
  and `s3:PutObject` — no `s3:ListBucket`. `aws s3 sync` (both directions)
  and `aws s3 ls` require `ListBucket` on the bucket resource; without it,
  resume would fail `AccessDenied` and the background checkpoint syncer
  would fail silently every interval (exactly the silent-failure shape
  ORCHESTRATION-DOCTRINE #9 warns about — ops team `2>/dev/null` on the sync
  call would have hidden it forever). Added
  `s3:ListBucket`/`s3:GetBucketLocation` on the bucket ARN.

**train.sh (multi-GPU):**
- `NPROC` knob (default 1). `NPROC>1` wraps the trainer in
  `torchrun --standalone --nproc_per_node=$NPROC -m ...`; `NPROC==1` keeps the
  exact prior single-process `$PY -m ...` invocation untouched. Per-device
  batch stays `BATCH`; `EFFECTIVE_BATCH=BATCH*NPROC` drives
  `steps_per_epoch`/`warmup_steps`. OOM loop still only halves per-device
  `BATCH`; `NPROC` is untouched by it (halving GPU count doesn't help OOM).
- Added a `DRYRUN` short-circuit directly in `train.sh` (not just `launch.sh`):
  prints the fully-resolved command (real flags, real computed warmup/steps
  for a placeholder pair count) and exits before any install/S3/GPU touch.
  This is what makes "prove the exact command for NPROC=4" checkable without
  a box.

**launch.sh:**
- Passes through `SAVE_STEPS`, `SAVE_TOTAL_LIMIT`, `CKPT_SYNC_INTERVAL`,
  `RESUME_FROM` (only exported if set), `NPROC` (only exported if set) into
  the box's user-data.
- IAM policy gets the `ListBucket` fix above.

**Verified so far (local, zero AWS spend):**
```
$ bash -n scripts/train/train.sh && echo OK   -> OK
$ bash -n scripts/train/launch.sh && echo OK  -> OK

$ MODE=train TRAIN_NAME=rigckpt RUN_ID=dryrun-nproc4 BUCKET=cshl-embed-rxiv-rigtest \
  NPROC=4 BATCH=8 DRYRUN=1 bash scripts/train/train.sh
[train.sh][DRYRUN] N_PAIRS=40000 NPROC=4 per_device_batch=8 effective_batch=32 steps_per_epoch=1250 warmup_steps=125
[train.sh][DRYRUN] would run:
/opt/pytorch/bin/torchrun --standalone --nproc_per_node=4 -m FlagEmbedding.finetune.embedder.encoder_only.m3 \
  --model_name_or_path BAAI/bge-m3 ... --per_device_train_batch_size 8 ... --warmup_steps 125 ...

$ MODE=train TRAIN_NAME=rigckpt RUN_ID=dryrun-nproc1 BUCKET=cshl-embed-rxiv-rigtest \
  NPROC=1 BATCH=8 DRYRUN=1 bash scripts/train/train.sh
[train.sh][DRYRUN] N_PAIRS=40000 NPROC=1 per_device_batch=8 effective_batch=8 steps_per_epoch=5000 warmup_steps=500
[train.sh][DRYRUN] would run:
/opt/pytorch/bin/python3 -m FlagEmbedding.finetune.embedder.encoder_only.m3 \
  --model_name_or_path BAAI/bge-m3 ... --per_device_train_batch_size 8 ... --warmup_steps 500 ...
```
Also ran `DRYRUN=1 ... RESUME_FROM=s3://.../checkpoints NPROC=4 ./launch.sh` and
confirmed the user-data correctly carries `export RESUME_FROM=...` /
`export NPROC=4`, and confirmed the unset case prints clean blank lines (no
broken heredoc) — see full transcript in this lane's tool history.

**Still owed:** the run-not-reasoned checkpointing acceptance test (real
rehearsal box: train, kill mid-run, resume, verify step continuation and a
complete final model dir) — isolated stack described above, in progress next.

## 2026-08-19T00:45Z — upgrade 3 (TYPE_MENU failover) implemented + tested, $0 spend

**launch.sh:** `TYPE` → `TYPE_MENU` (comma-separated, `TYPE_MENU=${TYPE_MENU:-${TYPE:-g6e.xlarge}}`
keeps back-compat). Final launch section rewritten: `IFS=',' read -r -a TYPES`,
nested loop — for each type, enumerate offered AZs (`describe-instance-type-
offerings` + `describe-subnets`, same as embed-nsr's existing AZ walk), then
walk subnets via `launch_in()`; `i-*` breaks both loops and returns; a
capacity/Unsupported error moves to the next AZ; any other error moves to the
next TYPE (not a silent full-menu abort — matches the embed-nsr precedent of
not retrying a non-capacity error blindly). Exhausting the whole menu is a
loud `exit 1` naming every type tried, never a silent no-op.

**The `set -e` bug (CSHL-CPT-REPORT.md "Two rig bugs found by the capacity
failure"):** ported the `OUT=$(launch_in ...) || true` fix from
`embed-nsr/launch.sh` — without it, `set -e` kills the whole script on the
FIRST capacity error inside the command-substitution assignment, so the loop
whose only job is "try the next AZ" can never run a second iteration.

**Proof the loop actually iterates (not reasoned about) — three separate runs:**

1. Zero-AWS standalone repro (`/tmp/.../setE-repro.sh`, file-based counter
   since `$(...)` runs in a subshell and a plain var increment inside it is
   invisible to the caller): buggy mode dies on AZ 1 (`exit 1`, `calls so far: 0`
   — never reaches AZ 2); fixed mode tries AZ 1, AZ 2, then succeeds on AZ 3
   (`exit 0`). Confirms the mechanism in isolation.

2. Real `scripts/train/launch.sh`, real code path, run against the isolated
   `cshl-rig-test` / `cshl-embed-rxiv-rigtest` stack, with a
   `FAKE_CAPACITY_FAIL` test hook added to the script (monkeypatches
   `launch_in` to return canned text instead of calling `run-instances`,
   activated only when the env var is set — same file-based-counter fix
   applied here too, since I made the exact same subshell mistake on the
   first pass and caught it before relying on the result):
   ```
   $ FAKE_CAPACITY_FAIL="3:i-0fakeSUCCESSCSHL01" TYPE_MENU="g5.xlarge" MODE=train \
     TRAIN_NAME=rigckpt RUN_ID=faketest-1 BUCKET=cshl-embed-rxiv-rigtest \
     ROLE=cshl-rig-test SG_NAME=cshl-embed-sg bash scripts/train/launch.sh
   type g5.xlarge: no capacity in subnet-0200d8f947fcf9090 — next AZ
   type g5.xlarge: no capacity in subnet-06b1914b54fc3e0c5 — next AZ
   type g5.xlarge: no capacity in subnet-09e840612db030382 — next AZ
   launched: i-0fakeSUCCESSCSHL01 (g5.xlarge, subnet-0aeeab33ec7ee352e)
   EXIT: 0
   ```
   Real `describe-instance-type-offerings`/`describe-subnets` calls (free,
   read-only) enumerated real AZs for a real type; only `run-instances` was
   faked, so this is $0 and zero real instances.

3. Same real path, full-menu exhaustion (`FAKE_CAPACITY_FAIL=999`,
   `TYPE_MENU="g5.xlarge,g6e.xlarge"`): tried all 5 AZs for g5.xlarge, all 4
   for g6e.xlarge (9 attempts total, both types), then
   `NO CAPACITY IN ANY AZ FOR ANY TYPE IN MENU: g5.xlarge,g6e.xlarge. Nothing
   launched.` and `exit 1` — loud failure, not a silent no-op.

**TEI_IMAGE:** the report's per-type image knob (Ada `89-1.8` vs Ampere
`86-1.8`) belongs to the *embed* rig, not this one — `scripts/train/train.sh`
never runs TEI (it's a host-python FlagEmbedding finetune, no inference
server on the box). Confirmed `embed-nsr/launch.sh` already carries the
`TEI_IMAGE` knob (added the night this bug was found — see its header
comment). Nothing to port into `scripts/train/launch.sh`; noted here instead
of fabricating an unused knob.

**Heredoc audit:** every heredoc touched in `launch.sh` (`MODE=manual` and
the training user-data block) uses unquoted `<<EOF`, same as before my edits.
The only backtick/`$()`-shaped content inside them is `\$(aws ssm ...)` and
`\$(curl ...)` — both already backslash-escaped in the original file so they
resolve on the BOX at run time, not in launch.sh's own shell at heredoc-
construction time. My additions (`RESUME_FROM`, `NPROC`, `SAVE_STEPS` etc.)
are plain `$VAR`/`${VAR:+...}` references to operator-supplied env vars, same
trust boundary as the pre-existing `TRAIN_NAME`/`MODEL_NAME` vars — no new
backtick or `$()` introduced, checked by eye and confirmed via the DRYRUN
transcripts above (`RESUME_FROM=s3://cshl-embed-rxiv-rigtest/models/x/y/checkpoints`
round-tripped through the heredoc unexecuted, as expected for a bucket path
with no shell metacharacters in it).

Cost so far: $0.00 (no EC2 instance launched yet). SSM param write, S3 head/
cp on the isolated bucket, and read-only EC2 describe calls only.
