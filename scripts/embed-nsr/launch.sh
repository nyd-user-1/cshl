#!/bin/bash
# embed rig launcher (CSHL / RxivGPT) — ported from the NSR rig at 8c1b05b,
# which was itself adapted from 44b scripts/embed-v2/launch.sh.
# N× g6e.xlarge (1 L40S each; G quota is 64 vCPUs = 16 boxes max, verified
# 2026-08-19), DLAMI base, TEI (bge-m3) + worker via user-data, self-terminating.
# DB URL travels .env.local → SSM SecureString → instance at boot; never in
# user-data plaintext, never echoed.
#
# CHANGED vs the NSR original (scripts/embed-nsr/launch.sh @ 8c1b05b):
#   - every NSR-ism is now an env knob with a CSHL default: TABLE/EMB_TABLE/KEY,
#     PARAM (/cshl/embed/dburl), ROLE/SG_NAME/BUCKET, CAP, REHEARSE_LO.
#   - DRYRUN=1: prints the plan (bounds, user-data, run-instances argv) and
#     touches NOTHING in AWS. Read-only DB only. This is the sign-off artifact.
#   - the bounds query reads preprints LEFT JOIN preprint_embeddings.
#   - CAP (input-recipe char cap) is passed to the worker instead of hardcoded.
#   - DB endpoint fence: refuses to run against anything but the CSHL endpoint.
#
# Usage (run from repo root):
#   DRYRUN=1 N=1 ./scripts/embed-nsr/launch.sh                       # plan only, no AWS, no spend
#   SCAFFOLD_ONLY=1 ./scripts/embed-nsr/launch.sh                     # create SSM/IAM/SG/S3 only ($0)
#   REHEARSE=3000 REHEARSE_LO=2024 N=1 ./scripts/embed-nsr/launch.sh  # bounded rehearsal
#   N=2 ./scripts/embed-nsr/launch.sh                                 # full run, 2 boxes
#   MODEL=ncbi/MedCPT-Article-Encoder DIM=768 EMB_TABLE=preprint_embeddings_medcpt \
#     EMB_MODEL=medcpt-article CAP=2000 NORMALIZE=0 N=1 ./scripts/embed-nsr/launch.sh  # a baseline arm
#   MODEL_S3=s3://cshl-embed-rxiv/models/cshl-encoder-bge-m3/<run>/final \
#     EMB_TABLE=preprint_embeddings_cshl EMB_MODEL=cshl-encoder-bge-m3 N=1 \
#     ./scripts/embed-nsr/launch.sh                                    # train rig Phase 3
set -euo pipefail
REGION=${REGION:-us-east-1}
N=${N:-1}
TYPE=${TYPE:-g6e.xlarge}
PARAM=${PARAM:-/cshl/embed/dburl}
ROLE=${ROLE:-cshl-embed}
SG_NAME=${SG_NAME:-cshl-embed-sg}
BUCKET=${BUCKET:-cshl-embed-rxiv}
LANES_UD=${LANES_UD:-4}
TABLE=${TABLE:-preprints}
EMB_TABLE=${EMB_TABLE:-preprint_embeddings}
KEY=${KEY:-key_number}
CAP=${CAP:-4000}            # input-recipe char cap; see LANE-RIG-PORT REPORT §1
MODEL=${MODEL:-BAAI/bge-m3}
DIM=${DIM:-1024}          # 768 for the MedCPT/SPECTER2/SciNCL baseline arms
# MODEL_S3 re-embeds the corpus with OUR fine-tuned weights instead of a Hub
# model — this is the train rig's Phase 3, moved onto the rig that is already
# sharded and resume-safe. Set it to s3://<bucket>/models/<name>/<run>/final .
# TEI ships one image per CUDA compute capability. 89 = Ada (L40S, L4);
# 86 = Ampere (A10G, on g5). Running the wrong one means the container starts
# and the model never loads. g6e capacity vanished mid-night, so this is a knob.
TEI_IMAGE=${TEI_IMAGE:-ghcr.io/huggingface/text-embeddings-inference:89-1.8}
MODEL_S3=${MODEL_S3:-}
NORMALIZE=${NORMALIZE:-1}          # 0 = store raw encoder output (MedCPT: dot product, not cosine)
RECLAIM_STALE=${RECLAIM_STALE:-}   # 1 = also re-embed rows whose text_hash no longer matches the recipe
MODEL_ID=${MODEL_S3:+/data}; MODEL_ID=${MODEL_ID:-$MODEL}
DRYRUN=${DRYRUN:-}
SCAFFOLD_ONLY=${SCAFFOLD_ONLY:-}   # create SSM/IAM/SG/S3 and stop; no bounds query, no instance
EXPECT_HOST=${EXPECT_HOST:-ep-orange-water-aut2eymf}

say() { echo "$@"; }
# Dry-run echoes argv, and one of these commands carries the Neon URL. Redact
# anything following --value before printing: the NSR rig leaked its live DB URL
# into three uploaded S3 logs exactly this way (set -x prints resolved values),
# and a dry-run whose whole purpose is to be pasted into a report is a worse
# place to leak it than a log file.
redact() { local out="" skip=0; for a in "$@"; do
    if [ "$skip" = 1 ]; then out="$out <redacted>"; skip=0; continue; fi
    [ "$a" = "--value" ] && skip=1
    out="$out $a"
  done; printf '%s' "${out# }"; }
run() { if [ -n "$DRYRUN" ]; then echo "  [dry-run] would run: $(redact "$@")"; else "$@"; fi; }

# 0. DB url from .env.local + endpoint fence (never echoed). A rig that writes
#    1024-d vectors into the wrong database is not recoverable by apology.
DBVAL=$(grep "^${DBURL_ENV:-DATABASE_URL_UNPOOLED}=" .env.local | head -1 | cut -d= -f2- | sed "s/^['\"]//;s/['\"]$//")
[ -n "$DBVAL" ] || { echo "no DB url in env ${DBURL_ENV:-DATABASE_URL_UNPOOLED}"; exit 1; }
DBHOST=$(printf '%s' "$DBVAL" | sed -E 's#^[^@]+@([^/?]+).*#\1#')
case "$DBHOST" in
  "$EXPECT_HOST".*) say "db endpoint: $EXPECT_HOST (fence ok)" ;;
  *) echo "FENCE FAIL: endpoint is '$DBHOST', expected '$EXPECT_HOST.*' — refusing." >&2; exit 1 ;;
esac

# 1. DB url into SSM (SecureString), never echoed
run aws ssm put-parameter --name $PARAM --type SecureString --value "$DBVAL" --overwrite --region $REGION
[ -n "$DRYRUN" ] || say "ssm param set: $PARAM"

# 2. IAM role + instance profile (SSM core for debugging + read the one param)
if [ -z "$DRYRUN" ] && ! aws iam get-role --role-name $ROLE >/dev/null 2>&1; then
  aws iam create-role --role-name $ROLE --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
  aws iam attach-role-policy --role-name $ROLE --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
  aws iam create-instance-profile --instance-profile-name $ROLE >/dev/null
  aws iam add-role-to-instance-profile --instance-profile-name $ROLE --role-name $ROLE
  echo "iam role created; waiting for propagation"; sleep 12
fi
# policy refresh is idempotent: read the one param, fetch worker, upload run log
POLICY="{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"ssm:GetParameter\",\"Resource\":\"arn:aws:ssm:$REGION:*:parameter$PARAM\"},{\"Effect\":\"Allow\",\"Action\":\"s3:GetObject\",\"Resource\":\"arn:aws:s3:::$BUCKET/*\"},{\"Effect\":\"Allow\",\"Action\":[\"s3:ListBucket\",\"s3:GetBucketLocation\"],\"Resource\":\"arn:aws:s3:::$BUCKET\"},{\"Effect\":\"Allow\",\"Action\":[\"s3:PutObject\",\"s3:AbortMultipartUpload\"],\"Resource\":[\"arn:aws:s3:::$BUCKET/logs/*\",\"arn:aws:s3:::$BUCKET/eval/*\"]}]}"
run aws iam put-role-policy --role-name $ROLE --policy-name read-dburl --policy-document "$POLICY"

# 3. Worker to S3 (bucket created on first run)
if [ -z "$DRYRUN" ]; then
  aws s3api head-bucket --bucket $BUCKET 2>/dev/null || aws s3 mb s3://$BUCKET --region $REGION >/dev/null
  aws s3 cp scripts/embed-nsr/worker.mjs s3://$BUCKET/worker.mjs >/dev/null
  say "worker uploaded: s3://$BUCKET/worker.mjs"
else
  say "  [dry-run] would upload scripts/embed-nsr/worker.mjs -> s3://$BUCKET/worker.mjs"
fi

# 4. Security group — egress only, zero ingress
if [ -z "$DRYRUN" ]; then
  VPC=$(aws ec2 describe-vpcs --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId' --output text --region $REGION)
  SG=$(aws ec2 describe-security-groups --filters Name=group-name,Values=$SG_NAME Name=vpc-id,Values=$VPC --query 'SecurityGroups[0].GroupId' --output text --region $REGION)
  if [ "$SG" = "None" ]; then
    SG=$(aws ec2 create-security-group --group-name $SG_NAME --description "cshl embed egress-only" --vpc-id $VPC --query GroupId --output text --region $REGION)
  fi
  # 5. Latest DLAMI base (OSS NVIDIA driver, Ubuntu 22.04)
  AMI=$(aws ssm get-parameter --name /aws/service/deeplearning/ami/x86_64/base-oss-nvidia-driver-gpu-ubuntu-22.04/latest/ami-id --query Parameter.Value --output text --region $REGION)
else
  SG='<sg-dryrun>'; AMI='<ami-resolved-at-launch>'
fi
say "sg: $SG"; say "ami: $AMI"

if [ -n "$SCAFFOLD_ONLY" ]; then
  echo "SCAFFOLD_ONLY: ssm=$PARAM role=$ROLE sg=$SG bucket=$BUCKET — no bounds query, no instance launched."
  exit 0
fi

# 6. Lane bounds, computed from the unembedded set at launch time.
#    L = N*LANES upper-boundary keys (last = global cap), so a rehearsal is
#    bounded above and the full run claims exactly what remains.
#    REHEARSE=<rows> limits the claim set; REHEARSE_LO picks its key prefix.
#    Careful: rxiv keys are DOI suffixes of two shapes — dotted ('2024.01.02.
#    123456') and bare legacy integers ('229468', '19000109') — and under
#    lexical ordering they INTERLEAVE rather than segregating ('229468' sorts
#    between '2022…' and '2023…', measured in a dry-run 2026-08-19). So
#    REHEARSE_LO does not cleanly select "recent papers"; it selects a key
#    range that happens to contain mostly recent ones plus some legacy strays.
#    That is fine for a throughput rehearsal and wrong for anything else.
# Preflight: the sidecar must exist before bounds can be computed. Without this
# the launcher dies on a raw psql "relation does not exist" three steps into the
# output, which reads like a rig bug rather than a missing migration.
EXISTS=$(psql "$DBVAL" -X -q -t -A -c "SELECT to_regclass('$EMB_TABLE') IS NOT NULL")
if [ "$EXISTS" != "t" ]; then
  echo "MISSING TABLE: $EMB_TABLE does not exist in this database." >&2
  echo "  Apply the embeddings sidecar DDL first (see docs/prompts/LANE-RIG-PORT.md REPORT §5-DDL)." >&2
  exit 1
fi

STALE_SQL=""
[ -n "$RECLAIM_STALE" ] && STALE_SQL=" OR e.text_hash <> md5(left(trim(coalesce(p.title,'') || E'\\n\\n' || coalesce(p.abstract,'')), $CAP))"
L=$((N * LANES_UD))
# A rehearsal needs its TOP bounded — that is what makes it a rehearsal. A full
# run must NOT be: bounds are computed from the rows that exist at launch, and
# the corpus is still being upserted by another lane, so a hard upper boundary
# at today's maximum key silently excludes every row that lands afterwards.
# Emitting L-1 boundaries leaves the last lane unbounded (worker: hi=null).
LAST_K=$L
[ -z "${REHEARSE:-}" ] && LAST_K=$((L - 1))
FILTER=""; LIMIT="rn <= 1000000000"
[ -n "${REHEARSE:-}" ] && { FILTER="AND p.$KEY >= '${REHEARSE_LO:-2024}'"; LIMIT="rn <= ${REHEARSE}"; }
BOUNDS=$(psql "$DBVAL" -X -q -t -A -c "
WITH todo AS (
  SELECT p.$KEY AS k, row_number() OVER (ORDER BY p.$KEY) AS rn
    FROM $TABLE p LEFT JOIN $EMB_TABLE e ON e.$KEY = p.$KEY
   WHERE (e.$KEY IS NULL$STALE_SQL)
     AND length(regexp_replace(coalesce(p.title,'') || coalesce(p.abstract,''), '\s+', '', 'g')) >= 20
     $FILTER
), lim AS (SELECT * FROM todo WHERE $LIMIT),
   t AS (SELECT max(rn) AS total FROM lim)
SELECT string_agg(k, ',' ORDER BY rn) FROM lim
 WHERE rn IN (SELECT (total * k) / $L FROM t, generate_series(1, $LAST_K) k)")
[ -n "$BOUNDS" ] || { echo "no bounds — nothing unembedded?"; exit 1; }
say "bounds ($L lanes): $BOUNDS"

# 7. Launch one box per partition (START to launch a single straggler)
for i in $(seq ${START:-0} $((N-1))); do
  UD=$(cat <<EOF
#!/bin/bash
exec > /var/log/embed.log 2>&1
set +x  # never trace: DB URL from SSM would land in the uploaded log
shutdown -h +120   # watchdog: nothing runs past 2h
export AWS_DEFAULT_REGION=$REGION
DBURL=\$(aws ssm get-parameter --name $PARAM --with-decryption --query Parameter.Value --output text)
${MODEL_S3:+mkdir -p /models/enc && aws s3 sync --only-show-errors $MODEL_S3 /models/enc}
docker run -d --gpus all -p 8080:80 ${MODEL_S3:+-v /models/enc:/data} --name tei $TEI_IMAGE \
  --model-id $MODEL_ID --dtype float16 --max-client-batch-size 256 --max-batch-tokens 131072
# Node from the official static tarball, NOT apt. The nodesource route wedged
# apt-get update for 3+ minutes on E0 (2026-08-19) with the box billing at
# \$0.031/min and TEI already healthy — the rig sat there paying for nothing and
# would have run to the 2h watchdog. A tarball has no repo, no lock contention
# and no mirror to hang on; node is only here to run one script.
curl -fsSL --max-time 180 https://nodejs.org/dist/v22.11.0/node-v22.11.0-linux-x64.tar.xz -o /tmp/node.tar.xz
mkdir -p /opt/node && tar -xJf /tmp/node.tar.xz -C /opt/node --strip-components=1
export PATH=/opt/node/bin:\$PATH
mkdir -p /opt/embed && cd /opt/embed && npm init -y >/dev/null && npm i pg --no-audit --no-fund >/dev/null
aws s3 cp s3://$BUCKET/worker.mjs worker.mjs
for t in \$(seq 1 60); do curl -sf http://127.0.0.1:8080/health && break; sleep 5; done
export PART=$i PARTS=$N PAGE=${PAGE:-1024} LANES=$LANES_UD
export TABLE=$TABLE EMB_TABLE=$EMB_TABLE KEY=$KEY CAP=$CAP DIM=$DIM NORMALIZE=$NORMALIZE EMB_MODEL=${EMB_MODEL:-bge-m3} DRAIN_WAIT_S=${DRAIN_WAIT_S:-0}${RECLAIM_STALE:+ RECLAIM_STALE=1}
export BOUNDS_KEYS='$BOUNDS' LO_CAP='${REHEARSE:+${REHEARSE_LO:-2024}}'
DATABASE_URL="\$DBURL" node worker.mjs
aws s3 cp /var/log/embed.log s3://$BUCKET/logs/cshl-embed-part$i-\$(date +%s).log
shutdown -h now
EOF
)
  if [ -n "$DRYRUN" ]; then
    echo "───── dry-run: box $i user-data ─────"; echo "$UD"; echo "───── end user-data ─────"
    echo "  [dry-run] would run: aws ec2 run-instances --region $REGION --image-id $AMI --instance-type $TYPE --count 1 ${SUBNET:+--subnet-id $SUBNET} --iam-instance-profile Name=$ROLE --security-group-ids $SG --instance-initiated-shutdown-behavior terminate --block-device-mappings '[{\"DeviceName\":\"/dev/sda1\",\"Ebs\":{\"VolumeSize\":100,\"VolumeType\":\"gp3\",\"DeleteOnTermination\":true}}]' --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=cshl-embed-${EMB_MODEL:-bge-m3}-$i},{Key=Arm,Value=${EMB_MODEL:-bge-m3}},{Key=Table,Value=$EMB_TABLE},{Key=Part,Value=$i}]' --user-data <above>"
    continue
  fi
  # g6e capacity is patchy and the failure is per-AZ, not regional: NSR's first
  # launch died on InsufficientInstanceCapacity in the default AZ while
  # us-east-1b had stock, and ours did the same tonight. Retrying by hand is
  # fine for N=1 and actively dangerous for N>1, where box 0 can succeed and
  # box 1 fail and leave a half-launched sweep. So: walk the AZs that actually
  # offer this instance type until one takes it.
  launch_in() {
    aws ec2 run-instances --region $REGION \
      --image-id "$AMI" --instance-type $TYPE --count 1 \
      ${1:+--subnet-id $1} \
      --iam-instance-profile Name=$ROLE \
      --security-group-ids "$SG" \
      --instance-initiated-shutdown-behavior terminate \
      --block-device-mappings '[{"DeviceName":"/dev/sda1","Ebs":{"VolumeSize":100,"VolumeType":"gp3","DeleteOnTermination":true}}]' \
      --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=cshl-embed-${EMB_MODEL:-bge-m3}-$i},{Key=Arm,Value=${EMB_MODEL:-bge-m3}},{Key=Table,Value=$EMB_TABLE},{Key=Part,Value=$i}]" \
      --user-data "$UD" \
      --query 'Instances[0].InstanceId' --output text 2>&1
  }
  if [ -n "${SUBNET:-}" ]; then
    CANDIDATES="$SUBNET"
  else
    OFFERED=$(aws ec2 describe-instance-type-offerings --region $REGION --location-type availability-zone \
      --filters Name=instance-type,Values=$TYPE --query 'InstanceTypeOfferings[].Location' --output text)
    CANDIDATES=""
    for az in $OFFERED; do
      sn=$(aws ec2 describe-subnets --region $REGION --filters Name=vpc-id,Values=$VPC Name=availability-zone,Values=$az \
             --query 'Subnets[0].SubnetId' --output text)
      [ "$sn" != "None" ] && CANDIDATES="$CANDIDATES $sn"
    done
  fi
  ID=""
  for sn in $CANDIDATES; do
    # `|| true` is load-bearing: under `set -e`, a failing command substitution
    # in an assignment exits the script — so without it the AZ-failover loop
    # dies on the FIRST capacity error and never tries a second AZ, which is
    # the entire reason the loop exists. Found the only way this kind of bug is
    # ever found: when the fallback path finally had to run.
    OUT=$(launch_in "$sn") || true
    case "$OUT" in
      i-*) ID="$OUT"; echo "box $i: $ID ($sn)"; break ;;
      *InsufficientInstanceCapacity*|*Unsupported*) echo "box $i: no capacity in $sn — next AZ" ;;
      *) echo "box $i: launch failed in $sn: $OUT"; break ;;
    esac
  done
  [ -n "$ID" ] || { echo "box $i: NO CAPACITY IN ANY AZ for $TYPE. Nothing launched." >&2; exit 1; }
done
