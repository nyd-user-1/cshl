#!/bin/bash
# score-launch.sh — Phase 3: rerank a frozen candidate pool on a GPU box.
#
# Separate from launch.sh on purpose. The training box self-terminates the
# moment train.sh returns (instance-initiated-shutdown-behavior=terminate), so
# there is no window to reuse it, and folding scoring into train.sh would put
# Phase 3's correctness behind a 50-minute training run every time it changes.
# This box carries NO database credential and NO training data — only the
# weights, rerank.py, and the frozen lists dump-candidates.mjs already froze.
#
#   MODEL_RUN=<run-id> ./scripts/rerank-nsr/score-launch.sh
set -euo pipefail
REGION=us-east-1
ROLE=${ROLE:-cshl-embed}
SG_NAME=${SG_NAME:-cshl-embed-sg}
BUCKET=${BUCKET:-cshl-embed-rxiv}
TYPE_MENU=${TYPE_MENU:-g5.xlarge,g6e.xlarge,g5.2xlarge}
WATCHDOG_MIN=${WATCHDOG_MIN:-45}
EVAL_VERSION=${EVAL_VERSION:-cshl-eval-2k}
ARM=${ARM:-cshl_qp}
MODEL_RUN=${MODEL_RUN:?set MODEL_RUN (the models/cshl-reranker-gte-modernbert/<run>/ to score)}
MODEL_SUB=${MODEL_SUB:-final}
RUN_ID=${RUN_ID:-$(date +%Y%m%d-%H%M%S)-score}
echo "run_id: $RUN_ID  model: $MODEL_RUN/$MODEL_SUB  arm: $ARM  eval: $EVAL_VERSION"

aws iam get-role --role-name $ROLE >/dev/null
VPC=$(aws ec2 describe-vpcs --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId' --output text --region $REGION)
SG=$(aws ec2 describe-security-groups --filters Name=group-name,Values=$SG_NAME Name=vpc-id,Values=$VPC --query 'SecurityGroups[0].GroupId' --output text --region $REGION)
AMI=${AMI:-ami-012ba162b9cd2729c}
aws s3 cp scripts/rerank-nsr/rerank.py s3://$BUCKET/reranker/rerank.py --only-show-errors
# refuse early and on the laptop rather than 6 minutes into a booted box
for k in "models/cshl-reranker-gte-modernbert/$MODEL_RUN/$MODEL_SUB/model.safetensors" \
         "reranker/eval/$EVAL_VERSION/$ARM.lists.json" "reranker/eval/$EVAL_VERSION/docs.jsonl"; do
  aws s3api head-object --bucket $BUCKET --key "$k" >/dev/null 2>&1 || { echo "missing s3://$BUCKET/$k"; exit 1; }
done
echo "preflight: weights + lists + docs all present"

UD=$(cat <<EOF
#!/bin/bash
exec > /var/log/score.log 2>&1
set -x
shutdown -h +$WATCHDOG_MIN
export AWS_DEFAULT_REGION=$REGION
pip install -U torch transformers 2>&1 | tail -20
D=/opt/rr; mkdir -p \$D/model
aws s3 cp --recursive --only-show-errors s3://$BUCKET/models/cshl-reranker-gte-modernbert/$MODEL_RUN/$MODEL_SUB/ \$D/model/
aws s3 cp --only-show-errors s3://$BUCKET/reranker/rerank.py \$D/rerank.py
aws s3 cp --only-show-errors s3://$BUCKET/reranker/eval/$EVAL_VERSION/$ARM.lists.json \$D/lists.json
aws s3 cp --only-show-errors s3://$BUCKET/reranker/eval/$EVAL_VERSION/docs.jsonl \$D/docs.jsonl
python3 \$D/rerank.py --model \$D/model --lists \$D/lists.json --docs \$D/docs.jsonl \\
  --out \$D/reranked-$RUN_ID.json
RC=\$?
# The UPLOAD is the deliverable, so its exit code is the run's exit code.
# Run 20260819-232122-score reranked all 100,000 pairs correctly, failed the
# PutObject on AccessDenied, and still printed SCORE-EXIT=0 — a clean-looking
# log and an empty prefix. Exactly the shape LANE-SHIP found in the publish rig.
# Never report success for work that did not land.
UP=1
if [ \$RC -eq 0 ]; then
  if aws s3 cp --only-show-errors \$D/reranked-$RUN_ID.json \\
       s3://$BUCKET/reranker/scored/$EVAL_VERSION/reranked-$RUN_ID.json; then
    UP=0
    aws s3api head-object --bucket $BUCKET \\
      --key reranker/scored/$EVAL_VERSION/reranked-$RUN_ID.json \\
      --query ContentLength --output text && echo "UPLOAD-VERIFIED"
  else
    echo "UPLOAD FAILED — the result exists on this box and is about to be destroyed"
  fi
fi
echo "SCORE-EXIT=\$RC UPLOAD-EXIT=\$UP"
aws s3 cp /var/log/score.log s3://$BUCKET/logs/cshl-reranker-score-$RUN_ID.log || true
shutdown -h now
EOF
)
launch_in() {
  aws ec2 run-instances --region $REGION --image-id "$AMI" --instance-type "$1" --count 1 \
    ${2:+--subnet-id "$2"} --iam-instance-profile Name=$ROLE --security-group-ids "$SG" \
    --instance-initiated-shutdown-behavior terminate \
    --block-device-mappings '[{"DeviceName":"/dev/sda1","Ebs":{"VolumeSize":100,"VolumeType":"gp3","DeleteOnTermination":true}}]' \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=cshl-rr-score-$RUN_ID},{Key=InstanceType,Value=$1}]" \
    --user-data "$UD" --query 'Instances[0].InstanceId' --output text 2>&1
}
IFS=',' read -r -a TYPES <<< "$TYPE_MENU"
if [ -n "${DRYRUN:-}" ]; then echo "$UD"; for t in "${TYPES[@]}"; do echo "[dry-run] would try $t"; done; exit 0; fi
ID=""
for TYPE in "${TYPES[@]}"; do
  OFFERED=$(aws ec2 describe-instance-type-offerings --region $REGION --location-type availability-zone \
    --filters Name=instance-type,Values=$TYPE --query 'InstanceTypeOfferings[].Location' --output text)
  for az in $OFFERED; do
    sn=$(aws ec2 describe-subnets --region $REGION --filters Name=vpc-id,Values=$VPC Name=availability-zone,Values=$az --query 'Subnets[0].SubnetId' --output text)
    [ "$sn" = "None" ] && continue
    OUT=$(launch_in "$TYPE" "$sn") || true    # `|| true` load-bearing under set -e
    case "$OUT" in
      i-*) ID="$OUT"; echo "launched: $ID ($TYPE, $sn)"; break 2 ;;
      *InsufficientInstanceCapacity*|*Unsupported*) echo "type $TYPE: no capacity in $sn — next AZ" ;;
      *) echo "type $TYPE: non-capacity error — next type: $OUT"; break ;;
    esac
  done
done
[ -n "$ID" ] || { echo "NO CAPACITY FOR ANY TYPE IN: $TYPE_MENU" >&2; exit 1; }
echo "result will land at s3://$BUCKET/reranker/scored/$EVAL_VERSION/reranked-$RUN_ID.json"
echo "$ID"
