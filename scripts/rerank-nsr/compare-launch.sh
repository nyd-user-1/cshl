#!/bin/bash
# compare-launch.sh — system-vs-system: run several (pool x cross-encoder) cells
# on ONE box. Report follow-up #7.
#
# The cells are chosen so the result is interpretable rather than just favourable:
#   A  medcpt pool + ncbi/MedCPT-Cross-Encoder   -> THEIR system, at THEIR published config
#   B  medcpt pool + cshl-RR                     -> our reranker on THEIR pool
# (A vs B isolates the reranker on an identical pool; A vs our existing
#  cshl_qp+cshl-RR row is the system-vs-system comparison the lead asked for.)
#
# Each cell runs at the config its model was published/trained for. MedCPT's card
# specifies max_length=512, so it gets 2000-char documents; cshl-RR was trained at
# 900 chars / 256 tokens and gets those. Handicapping MedCPT to our window would
# make any win worthless — see CSHL-CPT-REPORT "Baselines are measured here".
#
#   ./scripts/rerank-nsr/compare-launch.sh
set -euo pipefail
REGION=us-east-1
ROLE=${ROLE:-cshl-embed}
SG_NAME=${SG_NAME:-cshl-embed-sg}
BUCKET=${BUCKET:-cshl-embed-rxiv}
TYPE_MENU=${TYPE_MENU:-g5.xlarge,g6e.xlarge,g5.2xlarge}
WATCHDOG_MIN=${WATCHDOG_MIN:-40}
EVAL_VERSION=${EVAL_VERSION:-cshl-eval-2k}
OUR_RUN=${OUR_RUN:-20260819-223601-train}
RUN_ID=${RUN_ID:-$(date +%Y%m%d-%H%M%S)-cmp}
echo "run_id: $RUN_ID  eval: $EVAL_VERSION  our-reranker: $OUR_RUN"

# name | model | lists-arm | docs file | max-len
JOBS=(
  "medcpt_medcptce|ncbi/MedCPT-Cross-Encoder|medcpt|docs-2000.jsonl|512"
  "medcpt_cshlrr|S3:$OUR_RUN|medcpt|docs-900.jsonl|256"
)

aws iam get-role --role-name $ROLE >/dev/null
VPC=$(aws ec2 describe-vpcs --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId' --output text --region $REGION)
SG=$(aws ec2 describe-security-groups --filters Name=group-name,Values=$SG_NAME Name=vpc-id,Values=$VPC --query 'SecurityGroups[0].GroupId' --output text --region $REGION)
AMI=${AMI:-ami-012ba162b9cd2729c}
aws s3 cp scripts/rerank-nsr/rerank.py s3://$BUCKET/reranker/rerank.py --only-show-errors

# preflight every input on the laptop, where failing is free
NEED=("models/cshl-reranker-gte-modernbert/$OUR_RUN/final/model.safetensors")
for j in "${JOBS[@]}"; do
  IFS='|' read -r n m arm docs ml <<< "$j"
  NEED+=("reranker/eval/$EVAL_VERSION/$arm.lists.json" "reranker/eval/$EVAL_VERSION/$docs")
done
for k in $(printf '%s\n' "${NEED[@]}" | sort -u); do
  aws s3api head-object --bucket $BUCKET --key "$k" >/dev/null 2>&1 || { echo "MISSING s3://$BUCKET/$k"; exit 1; }
done
echo "preflight: all $(printf '%s\n' "${NEED[@]}" | sort -u | wc -l | tr -d ' ') inputs present"

JOBLINES=$(printf '%s\n' "${JOBS[@]}")
UD=$(cat <<EOF
#!/bin/bash
exec > /var/log/compare.log 2>&1
set -x
shutdown -h +$WATCHDOG_MIN
export AWS_DEFAULT_REGION=$REGION
pip install -U torch transformers 2>&1 | tail -15
D=/opt/cmp; mkdir -p \$D
aws s3 cp --only-show-errors s3://$BUCKET/reranker/rerank.py \$D/rerank.py
mkdir -p \$D/ourmodel
aws s3 cp --recursive --only-show-errors s3://$BUCKET/models/cshl-reranker-gte-modernbert/$OUR_RUN/final/ \$D/ourmodel/
FAILED=0
while IFS='|' read -r NAME MODEL ARM DOCS MAXLEN; do
  [ -n "\$NAME" ] || continue
  echo "=== CELL \$NAME  model=\$MODEL  pool=\$ARM  docs=\$DOCS  max_len=\$MAXLEN ==="
  # Deliberately no case-statement and no backticks in this block: the heredoc is
  # expanded inside a command substitution, so an unbalanced close-paren ends it
  # early and a backtick starts a nested substitution. Prefix-strip instead.
  if [ "\${MODEL#S3:}" != "\$MODEL" ]; then MPATH=\$D/ourmodel; else MPATH="\$MODEL"; fi
  [ -f \$D/\$ARM.lists.json ] || aws s3 cp --only-show-errors s3://$BUCKET/reranker/eval/$EVAL_VERSION/\$ARM.lists.json \$D/\$ARM.lists.json
  [ -f \$D/\$DOCS ] || aws s3 cp --only-show-errors s3://$BUCKET/reranker/eval/$EVAL_VERSION/\$DOCS \$D/\$DOCS
  python3 \$D/rerank.py --model "\$MPATH" --lists \$D/\$ARM.lists.json --docs \$D/\$DOCS \\
    --out \$D/reranked-\$NAME.json --max-len \$MAXLEN
  RC=\$?
  if [ \$RC -ne 0 ]; then echo "CELL \$NAME FAILED rc=\$RC"; FAILED=1; continue; fi
  # the upload is the deliverable: verify the object back before moving on
  if aws s3 cp --only-show-errors \$D/reranked-\$NAME.json \\
       s3://$BUCKET/reranker/scored/$EVAL_VERSION/reranked-$RUN_ID-\$NAME.json; then
    SZ=\$(aws s3api head-object --bucket $BUCKET \\
      --key reranker/scored/$EVAL_VERSION/reranked-$RUN_ID-\$NAME.json --query ContentLength --output text)
    echo "CELL \$NAME UPLOAD-VERIFIED bytes=\$SZ"
  else
    echo "CELL \$NAME UPLOAD FAILED — result destroyed with this box"; FAILED=1
  fi
done <<'JOBS_EOF'
$JOBLINES
JOBS_EOF
echo "COMPARE-EXIT=\$FAILED"
aws s3 cp /var/log/compare.log s3://$BUCKET/logs/cshl-rr-compare-$RUN_ID.log || true
shutdown -h now
EOF
)
launch_in() {
  aws ec2 run-instances --region $REGION --image-id "$AMI" --instance-type "$1" --count 1 \
    ${2:+--subnet-id "$2"} --iam-instance-profile Name=$ROLE --security-group-ids "$SG" \
    --instance-initiated-shutdown-behavior terminate \
    --block-device-mappings '[{"DeviceName":"/dev/sda1","Ebs":{"VolumeSize":120,"VolumeType":"gp3","DeleteOnTermination":true}}]' \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=cshl-rr-cmp-$RUN_ID},{Key=InstanceType,Value=$1}]" \
    --user-data "$UD" --query 'Instances[0].InstanceId' --output text 2>&1
}
IFS=',' read -r -a TYPES <<< "$TYPE_MENU"
if [ -n "${DRYRUN:-}" ]; then echo "$UD"; exit 0; fi
ID=""
for TYPE in "${TYPES[@]}"; do
  OFFERED=$(aws ec2 describe-instance-type-offerings --region $REGION --location-type availability-zone \
    --filters Name=instance-type,Values=$TYPE --query 'InstanceTypeOfferings[].Location' --output text)
  for az in $OFFERED; do
    sn=$(aws ec2 describe-subnets --region $REGION --filters Name=vpc-id,Values=$VPC Name=availability-zone,Values=$az --query 'Subnets[0].SubnetId' --output text)
    [ "$sn" = "None" ] && continue
    OUT=$(launch_in "$TYPE" "$sn") || true   # `|| true` load-bearing under set -e
    case "$OUT" in
      i-*) ID="$OUT"; echo "launched: $ID ($TYPE, $sn)"; break 2 ;;
      *InsufficientInstanceCapacity*|*Unsupported*) echo "type $TYPE: no capacity in $sn — next AZ" ;;
      *) echo "type $TYPE: non-capacity error — next type: $OUT"; break ;;
    esac
  done
done
[ -n "$ID" ] || { echo "NO CAPACITY FOR ANY TYPE IN: $TYPE_MENU" >&2; exit 1; }
echo "results -> s3://$BUCKET/reranker/scored/$EVAL_VERSION/reranked-$RUN_ID-<cell>.json"
echo "$ID"
