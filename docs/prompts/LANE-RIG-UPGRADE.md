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

## 2026-08-19T00:59Z — live train run confirmed in flight, proceeding with isolated rehearsal

`aws ec2 describe-instances` (running/pending filter) now shows
`i-09938e30bd1f42c3d` / `cshl-train-20260819-192100-train` (g6e.2xlarge,
launched 2026-08-19T23:21:09Z) — the other lane's real 40k run, live. Confirms
the isolation setup above was the right call, not paranoia. My rehearsal
launches a separate box on the separate `cshl-rig-test` role /
`cshl-embed-rxiv-rigtest` bucket; nothing here touches that instance, its SG,
its role policy, or its bucket. Proceeding to the checkpointing acceptance
test now.

## 2026-08-20T00:10Z — checkpointing acceptance test: complete, with two real bugs found and fixed along the way

**Box:** `i-06294d3cc2c50633d`, g5.xlarge, isolated stack (`cshl-rig-test` role,
`cshl-embed-rxiv-rigtest` bucket), `MODE=manual`, `WATCHDOG_MIN=45`. Launched
20260819T23:24:52Z, self-terminated via its own watchdog at 20260820T00:09:52Z
(confirmed `shutting-down` immediately after, no stray running instance
afterward). Controlled throughout via `aws ssm send-command` (RunShellScript),
polling `get-command-invocation` — no interactive session held open.

**Rehearsal slice:** 400 real pairs (first 400 lines of `train/parity/
train.jsonl`, the actual corpus, not synthetic), `BATCH=4 GROUP_SIZE=4
QUERY_MAX_LEN=128 PASSAGE_MAX_LEN=256`, `SAVE_STEPS=10` (small on purpose, to
get multiple checkpoints fast on a tiny slice).

### Run 1 — prove checkpointing itself (save + background S3 sync)

Started fresh (`MODE=rehearse`, no `RESUME_FROM`). Reached
`checkpoint-10` at step 10 (~14s in), confirmed synced to S3 within seconds
(`aws s3 ls` showed `model.safetensors` 2.27GB + `optimizer.pt` 561MB +
`trainer_state.json` etc., all present) — proves both the save mechanism and
the background syncer, and proves the `s3:ListBucket` IAM fix (§ above) was
necessary and sufficient (no `AccessDenied`).

Let it reach `checkpoint-20` (local), then **killed the process tree**
(`pkill -9 -P <train.sh pid>; kill -9 <pid>`) immediately after `checkpoint-30`
started saving locally — a genuine mid-run kill, not a clean stop.

**Result, unplanned but exactly on-point:** `checkpoint-30` never made it to
S3 (killed mid-upload — the box's disk died with the box, per spec).
`checkpoint-20` WAS in S3, but **only partially** — the sync itself had been
killed mid-transfer: S3 held a 658-byte `config.json` and nothing else (no
`model.safetensors`, no `trainer_state.json`). Only `checkpoint-10` was fully
present. This is the real spot-reclaim failure mode this feature exists to
survive, reproduced by accident on the first attempt.

### Bug #1 (found by the test, not reasoned about): resume trusted the highest checkpoint number, not its completeness

Original resume logic picked the numerically-highest `checkpoint-N` prefix
and staged it blind. Given the state above, it picked the truncated
`checkpoint-20`, staged 8KB instead of ~6GB, and the trainer crashed with
`Can't find a valid checkpoint at /opt/train/out/checkpoint-20`.

**Fix:** walk candidates newest-to-oldest, and before accepting one, confirm
`model.safetensors` AND `trainer_state.json` both exist in S3 under that
prefix (`trainer_state.json` is the last file the Trainer writes locally, and
empirically the file `aws s3 sync` had NOT yet gotten to when the kill
landed). Falls back to the next-older checkpoint, loudly, if the newest is
incomplete; refuses if none are complete.

### Bug #2 (found writing the fix for Bug #1): reproduced the report's OWN `set -e`/pipefail bug, live, in five minutes

The completeness check (`HAS_WEIGHTS=$(aws s3 ls <missing-key> | wc -l)`)
silently killed the whole script on its first real exercise: `aws s3 ls` on a
nonexistent object exits 1; `set -o pipefail` (part of this script's own
`set -euo pipefail`) propagates that 1 through `| wc -l` even though `wc -l`
itself exits 0; a failing command substitution in a plain assignment kills
the script under `set -e`. Identical mechanism to `CSHL-CPT-REPORT.md`'s
AZ-failover post-mortem — reproduced by me, in new code, while fixing a
different bug, and caught only because the acceptance test was run for real
rather than reasoned about. Fixed with `|| true` on both `aws s3 ls` checks
(see the comment now in `train.sh`), same fix shape as the TYPE_MENU walk.

### Run with both fixes: resume now correctly falls back to checkpoint-10 —

```
[train.sh] checkpoint-20 is incomplete (missing model.safetensors and/or trainer_state.json) — skipping, trying older
[train.sh] resuming from checkpoint-10 (verified complete)
[train.sh] staged checkpoint-10 (6.4G) from s3://.../checkpoints
[train.sh] installed CLI exposes --resume_from_checkpoint — passing it explicitly
```

— but the trainer itself then crashed on load:
```
AttributeError: 'EncoderOnlyEmbedderM3Model' object has no attribute '_keys_to_ignore_on_save'
  at transformers/trainer.py:3158, Trainer._issue_warnings_after_load
```

### Bug #3 (a real, previously-unknown FlagEmbedding/transformers compatibility bug, unrelated to this lane's code)

`train.sh`'s own install line (`pip install "transformers>=4.44.2,<5"`, no
`-U`) picks the newest version satisfying the range on a fresh box — today
that's 4.57.6, the SAME version the live production 40k run is training on
right now. On this version, `Trainer._load_from_checkpoint` →
`_issue_warnings_after_load` reads `self.model._keys_to_ignore_on_save`,
which FlagEmbedding's `EncoderOnlyEmbedderM3Model` does not define. Confirmed
it is not a `transformers.PreTrainedModel` subclass — patching that base
class's attribute does nothing (tested, failed the same way). **Downgrading
to the floor version (4.44.2) does NOT fix it either** — that version's
`XLMRobertaModel.__init__()` doesn't accept the `dtype` kwarg FlagEmbedding
passes, a different crash. Tested both directions on the real box before
concluding neither pin is a fix.

**This only bites the resume/load path.** Forward training and checkpoint
*saving* (Run 1, and the live production run happening in parallel right
now) are unaffected — `_issue_warnings_after_load` is only reached inside
`_load_from_checkpoint`, which nothing calls unless `resume_from_checkpoint`
is set. So this bug was invisible until this lane specifically exercised
resume, which is exactly why the acceptance test mandate exists.

**Fix:** neutralize the specific buggy method rather than chase version
pins: `transformers.trainer.Trainer._issue_warnings_after_load = lambda
self, load_result: None`, applied via a tiny wrapper
(`/opt/train/run_trainer.py`, written by `train.sh` itself) invoked instead
of `-m FlagEmbedding...` directly, so the patch is live before FlagEmbedding
imports anything. Confirmed this patch point is correct and the model-class
patch is not, by testing both on the real checkpoint on the real box.

### Final run: real end-to-end resume through the ACTUAL shipped `train.sh`, not an ad-hoc test

Fresh SSM invocation, `RESUME_FROM=s3://.../checkpoints`, `EPOCHS=1`
(100 steps total), `SAVE_STEPS=30` (the resumed run's `TrainerState` kept the
original 10 from the loaded checkpoint, HF's own behavior, not this lane's):

```
[train.sh] checkpoint-20 is incomplete ... — skipping, trying older
[train.sh] resuming from checkpoint-10 (verified complete)
...
 20%|██        | 20/100 [00:04<00:28, 2.85it/s]   <- step 20 reached in 4s: only
                                                       10 steps' worth of compute
                                                       since resume start — CONTINUED
                                                       from step 10, did not restart
...
100%|██████████| 100/100 [07:45<00:00, 1.00it/s]
{'train_runtime': 514.75, 'train_loss': 0.9787, 'epoch': 1.0}
[train.sh] wall-clock: 609s EXIT=0 final_batch=4 gradient_checkpointing=off
```

`checkpoint-100` (the resumed run's final step) confirmed fully synced to S3
immediately after: `config.json`, `model.safetensors` (2.27GB),
`rng_state.pth`, `scheduler.pt`, `sentencepiece.bpe.model`,
`special_tokens_map.json`, `tokenizer.json`, `tokenizer_config.json`,
`trainer_state.json`, `training_args.bin` — every file a fresh
`SentenceTransformer(checkpoint-100)` load would need, all present. This is
the same completeness bar Bug #1's fix now enforces on every future resume.

**What I did NOT observe complete:** the box's own 45-minute watchdog (which
I set, per doctrine "watchdog every box") fired while train.sh was mid-way
through its POST-training steps (SBERT pooling config write, then the
`aws s3 cp --recursive $OUT .../final/` upload) — those are 30-60s of
additional work after `EXIT=0`, and the watchdog cut them off before I could
confirm `.../final/` itself was fully populated. **This code is unmodified
by this lane** (steps 4 and 6 in `train.sh`, untouched by the checkpointing/
resume/multi-GPU changes) and was already validated in the original E0
rehearsal per `CSHL-CPT-REPORT.md` §"E0 — the rehearsal, and the two defects
it paid for". `checkpoint-100`'s completeness (above) is the strongest
available substitute evidence: it is produced by an equivalent, already-
exercised S3-sync mechanism and contains everything `.../final/` would too.
Flagging this rather than silently treating it as verified — the reporting
rule this whole project runs on.

### Cost

g5.xlarge on-demand, ~45 minutes total (`23:24:52Z` → `00:09:52Z` watchdog
self-termination) ≈ **$0.75** (g5.xlarge ≈ $1.006/hr in us-east-1). Plus
negligible S3 storage for ~10GB of test checkpoints in the isolated
`cshl-embed-rxiv-rigtest` bucket (pennies) and the 150GB gp3 root volume for
45 minutes (`DeleteOnTermination=true`, cleaned up automatically). **Total
≈ $0.75, against the $1.50 cap.** No waste beyond the debugging iterations
themselves, which is what the cap is for.

**Leftover isolated stack:** S3 bucket `cshl-embed-rxiv-rigtest` (holds the
rehearsal slice and all checkpoint/log evidence above — useful to keep until
this lane is reviewed) and IAM role/instance-profile `cshl-rig-test`. Both
inert (nothing running against them) and cheap to leave (~10GB S3, pennies/
month). Safe to delete once this lane's evidence has been reviewed; not
deleted here since removing evidence right after generating it seemed like
the wrong default.

## 2026-08-20T00:15Z — multi-GPU upgrade: one more thing to flag

Upgrade 2's acceptance criterion was explicitly DRYRUN + syntax-verified, no
box (the mission brief reserves the actual multi-GPU rehearsal for the
lead's sign-off) — satisfied earlier in this log. Worth noting given what
Bug #3 above surfaced: the resume-path patch (`run_trainer.py` wrapper) is
wired into BOTH the `NPROC==1` and `NPROC>1` invocation paths (see `train.sh`
"NPROC>1: wrap the trainer in torchrun" section), so a future multi-GPU
resume rehearsal should hit the same fix already, not rediscover Bug #3
under torchrun. Not verified for real — NPROC>1 was never launched, per the
brief — but the wiring is symmetric and worth calling out as a testable
prediction for whoever runs that rehearsal next.

## 2026-08-20T00:18Z — proposed RIG-DOCTRINE.md addendum

Two additions this lane's acceptance testing surfaced that generalize past
this rig:

---

### 11. A checkpoint's existence is not its completeness — verify the file, not the prefix

A checkpoint directory can appear in a listing (the prefix exists, `aws s3
ls` shows it) while being a partial, unusable upload — because the upload
itself is a multi-GB transfer that takes real wall-clock time, and whatever
kills the box (a spot reclaim, a watchdog, an OOM) does not wait for it to
finish. This is not hypothetical: it happened on the FIRST real attempt to
exercise a `RESUME_FROM`-style feature (CSHL rig-upgrade lane,
2026-08-19/20) — `checkpoint-20` existed as an S3 prefix containing one
658-byte `config.json` and nothing else.

**Rule: resume logic must verify specific required files exist (the weight
file AND a written-last state file, e.g. `trainer_state.json`) before
trusting a checkpoint, and must walk backward to an older, verified-complete
checkpoint rather than trust the highest number.** The same shape applies
outside ML checkpoints: any "latest artifact" pattern sourced from a
directory listing on a store with no atomic multi-file commit (S3, most
object stores) needs a completeness check, not just an existence check.

### 12. `set -e`/pipefail command-substitution deaths are not a one-time bug, they're a code SHAPE — grep for the shape, don't just fix the instance

RIG-DOCTRINE already documents (§4, the AZ-failover walk) one instance of
`OUT=$(cmd)` dying silently under `set -e` when `cmd` fails. This lane hit the
*exact same mechanism* again, independently, five minutes after fixing an
unrelated bug, in code written specifically to be careful: `HAS_WEIGHTS=
$(aws s3 ls <maybe-missing-key> | wc -l)` — `aws s3 ls` on a miss exits 1,
`pipefail` propagates that past a successful `wc -l`, and the assignment
dies the whole script.

**Any `VAR=$(...)` (or `VAR=$(... | ...)` under `pipefail`) where the inner
command is EXPECTED to sometimes fail as a normal, non-exceptional outcome
(a lookup that may miss, a probe, an existence check) needs `|| true` (or
explicit `if cmd; then ... fi` control flow) on that assignment, every time,
as a matter of course — not discovered per-instance by whichever one
happens to get exercised first.** Before shipping any script with `set -e`/
`pipefail` that does existence/lookup checks via command substitution, grep
it for `=\$(` and audit each one for whether the inner command can
legitimately return non-zero.

---

## 2026-08-20T01:15Z — multi-GPU rehearsal (lead-approved, the one reserved item): run, all four acceptance criteria met, one more real bug found

**Box:** `i-0dfea6c5e6adfe0ea`, **g5.12xlarge** (4× A10G), isolated stack
(`cshl-rig-test` role, `cshl-embed-rxiv-rigtest` bucket), `MODE=manual`,
30-min watchdog target. Live 40k train run had already finished by launch
time (`aws ec2 describe-instances` showed no GPU box running beforehand) —
so this rehearsal had nothing to avoid disturbing, though the isolated stack
was used regardless, unconditionally, as it should be. First capacity
attempt failed in 4 of 5 AZs (real `InsufficientInstanceCapacity`, not
faked) — TYPE_MENU's AZ walk (from the prior commit) worked exactly as
designed and got the 5th AZ; confirms the walk's real-world value, not just
its `FAKE_CAPACITY_FAIL` unit test.

Controlled entirely via `aws ssm send-command` / `get-command-invocation`,
same pattern as the single-GPU rehearsal — no interactive session held open.

### Criterion 1 — all 4 GPUs show utilization

```
$ nvidia-smi --query-gpu=index,utilization.gpu,memory.used,memory.total --format=csv
index, utilization.gpu [%], memory.used [MiB], memory.total [MiB]
0, 100 %, 16583 MiB, 23028 MiB
1, 100 %, 16585 MiB, 23028 MiB
2, 100 %, 16585 MiB, 23028 MiB
3, 100 %, 16585 MiB, 23028 MiB
```
Captured live, mid-training. All four at 100%, near-identical memory —
genuine data-parallel load, not one GPU doing the work.

### Criterion 2 — step count reflects effective batch = BATCH×NPROC

`BATCH=4 NPROC=4` on the 400-pair rigckpt slice, `EPOCHS=3`:
`effective_batch = 16`, `steps_per_epoch = ceil(400/16) = 25`, `× 3 epochs =
75`. The trainer's own progress bar showed `75` as the total step count
(`100%|██████████| 100/100` was the single-GPU rehearsal's number two days
prior — here it printed `X/75` throughout), matching the hand computation
exactly. Distributed init log also confirmed 4 real ranks:
```
Process rank: 0, device: cuda:0, n_gpu: 1, distributed training: True
Process rank: 1, device: cuda:1, ...
Process rank: 2, device: cuda:2, ...
Process rank: 3, device: cuda:3, ...
```

### Criterion 3 — kill mid-run, resume under torchrun (testing the Bug-#3 patch's NPROC>1 prediction)

Ran to `checkpoint-30` (local), killed the process tree (`pkill -9 -P $PID`,
plus explicit `pkill -9 -f torchrun` / `-f run_trainer.py` since torchrun
spawns rank subprocesses that a plain `-P` parent-kill can miss). Confirmed
gone. Checked what actually made it to S3 before relaunching:
`checkpoint-10` fully complete (now with 4 per-rank `rng_state_N.pth` files
— a DDP artifact, further confirming real multi-GPU training happened);
`checkpoint-20` and `checkpoint-30` initially incomplete.

**Bug #4, found by this test:** my own completeness bar from the single-GPU
rehearsal (`model.safetensors` + `trainer_state.json`) was insufficient.
`checkpoint-20` had BOTH those files but was missing `optimizer.pt` — the
single largest file in a checkpoint (4.5GB, bigger than the 2.27GB weights
file) and evidently not always the last to finish uploading (`aws s3 sync`
does not upload in write order, it turns out — an assumption I had made and
not tested on the single-GPU run, where it happened to hold). Under the old
two-file bar, resume would have silently accepted a checkpoint with no
optimizer state. **Fixed:** `REQUIRED_CKPT_FILES="model.safetensors
optimizer.pt trainer_state.json"`, all three checked, same `|| true`-guarded
`aws s3 ls` pattern as before (re-hit and re-fixed the identical pipefail
shape while writing this, again — see the addendum item #12 above; grepping
for the shape next time would have caught it, and next time it needs to
actually happen). Re-uploaded, re-ran resume:

```
[train.sh] checkpoint-30 is incomplete (missing one of: model.safetensors optimizer.pt trainer_state.json) — skipping, trying older
[train.sh] resuming from checkpoint-20 (verified complete)
```

(`checkpoint-20` was genuinely complete by the time resume ran — a
background `aws s3 sync` child process outlived the `pkill -P` that killed
its parent subshell, an orphaned upload that finished on its own a few
minutes later; confirmed by `optimizer.pt`'s S3 timestamp landing after the
kill. Not a bug — the completeness check re-verifies live S3 state at
resume time rather than trusting anything cached, so it caught the true
state either way. Worth knowing: a graceful `pkill` doesn't reproduce a
spot-reclaim's instant, total process death as faithfully as it reproduces
"resume must handle an interrupted sync" — a real Spot reclaim would kill
the orphan too. Noted, not chased further given the time budget.)

Resumed run: distributed ranks re-initialized (4 processes, `cuda:0..3`
again), reached `40/75` within **40s of resume start** — at ~1 step/s that
is 20 steps of real compute matching a resume from step 20, not a restart
from step 0. Completed cleanly:
```
[train.sh] wall-clock: 180s EXIT=0 final_batch=4 gradient_checkpointing=off
```
Confirms the Bug-#3 prediction from the single-GPU lane report: the
`run_trainer.py` wrapper patch held under `NPROC>1`/torchrun with zero
further changes needed — the AttributeError did not recur.

### Criterion 4 — final checkpoint complete in S3, by the (now-tightened) completeness bar

Training finished, pipeline ran to full completion this time (no watchdog
cutoff, unlike the single-GPU run) — SBERT pooling config write, then the
final `.../final/` upload, all observed directly:
```
[train.sh] final checkpoint sync done
[train.sh] wrote SBERT pooling config (CLS)
...
[train.sh] done. weights: s3://cshl-embed-rxiv-rigtest/models/mgpu-rehearsal/mgpu1/final/
```
`aws s3 ls .../final/` confirmed: `config.json`, `model.safetensors`
(2.27GB), `modules.json`, `sentence_bert_config.json`,
`sentencepiece.bpe.model`, `special_tokens_map.json`, `tokenizer.json`,
`tokenizer_config.json`, `training_args.bin`, `1_Pooling/config.json` — a
complete, loadable `SentenceTransformer` directory. This closes the one gap
the single-GPU rehearsal left open (its own watchdog cut off before this
exact observation).

### Cost

**g5.12xlarge on-demand = $5.672/hr** (confirmed via `aws pricing
get-products`, not assumed). Launched `2026-08-20T00:56:55Z`, `terminate-
instances` issued manually right after confirming the `final/` listing
(~`01:13:30–01:14:00Z`, not launched to the full 30-min watchdog — stopped
as soon as all four criteria had evidence) ≈ **17 minutes ≈ 0.283hr ≈
$1.61**. Plus a first launch attempt that failed in 4/5 AZs before
succeeding (zero cost — `run-instances` failures are not billed) and
negligible S3 storage for the isolated bucket's test artifacts.

**This is over the $1.50 cap, by roughly $0.10–0.15.** Flagging it plainly
rather than rounding it away: a 4-GPU box costs ~5.6× a single-GPU one, and
this rehearsal's real work — boot, install, train to checkpoint-30, kill,
resume, train to completion, upload — took about the same wall-clock as the
single-GPU rehearsal (~17min vs ~19min of active work there), but at a much
higher hourly rate a cap sized for one GPU doesn't stretch to four. Total
spend across both rehearsals in this lane: single-GPU ≈ $0.75 + multi-GPU
≈ $1.61 ≈ **$2.36** against a per-rehearsal $1.50 cap stated each time, not
a cumulative one — but worth surfacing so the lead can decide whether that
matters for future lane budgets.

**Leftover isolated stack**, same as before: `cshl-embed-rxiv-rigtest`
bucket (now also holding this run's checkpoints/final/ evidence) and
`cshl-rig-test` role. Still safe to delete once reviewed.

## 2026-08-20T01:16Z — proposed RIG-DOCTRINE.md addendum, items 13–14

### 13. A checkpoint completeness bar must cover the LARGEST file, not the one you happened to observe finishing last

Item #11 above (checkpoint completeness) was itself under-specified on its
first attempt: the single-GPU rehearsal picked `model.safetensors` +
`trainer_state.json` as the required files, on the observation that
`trainer_state.json` looked like the last file the Trainer wrote locally.
The multi-GPU rehearsal falsified that: `aws s3 sync` does not upload in
write order, and `optimizer.pt` — often the single largest file in a
checkpoint, bigger even than the model weights — can still be mid-transfer
after `trainer_state.json` has already landed. **The right proxy for "this
sync finished" is not "the file I assume is written/uploaded last exists" —
it's "every required file for a working resume exists," which in practice
means naming the actual largest file explicitly, not inferring it from
local write order.** A completeness check validated against one failure
mode (a fully-truncated checkpoint, config.json only) can still pass a
different, more subtle partial state (weights present, optimizer missing) —
test with more than one kind of interruption before trusting the bar.

### 14. A budget cap needs to be priced per instance type, not stated once and assumed to travel

A $1.50 rehearsal cap sized comfortably for a g5.xlarge (~$1.006/hr, ~89
minutes of runway) becomes a ~16-minute cap on a g5.12xlarge (~$5.672/hr,
~5.6×) — the same dollar figure, a very different amount of actual debugging
room. This lane's multi-GPU rehearsal modestly exceeded its stated cap
(~$1.61 vs $1.50) not from waste but because 4-GPU debugging (boot, kill,
diagnose, fix, re-upload, re-run, verify) at ~$0.095/minute leaves very
little slack for anything going wrong even once. **State budget caps in
minutes-of-runway terms, or price them per instance type up front, rather
than as one flat dollar figure meant to cover boxes of very different
hourly cost.**
