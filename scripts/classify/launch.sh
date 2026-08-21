#!/bin/bash
# LANE-LIBRARIAN launcher — ported from scripts/train/launch.sh (the upgraded rig).
# Carries the parts that matter and drops the contrastive-specific ones:
#   KEPT: TYPE_MENU type+AZ failover with the load-bearing `|| true`, the endpoint
#         fence, SSM SecureString for the DB url, xtrace discipline around the
#         credential, watchdog shutdown, instance-initiated-shutdown-behavior
#         terminate, DRYRUN, FAKE_CAPACITY_FAIL.
#   DROPPED: FlagEmbedding slice/manifest plumbing — this rig's gate lives in run.sh.
#
# Usage:
#   DRYRUN=1 ./scripts/classify/launch.sh
#   RUN_ID=... ./scripts/classify/launch.sh
set -euo pipefail
REGION=${REGION:-us-east-1}
TYPE_MENU=${TYPE_MENU:-${TYPE:-g6e.2xlarge,g6e.4xlarge,g5.2xlarge,g6.2xlarge}}
PARAM=${PARAM:-/cshl/embed/dburl}
ROLE=${ROLE:-cshl-embed}
SG_NAME=${SG_NAME:-cshl-embed-sg}
BUCKET=${BUCKET:-cshl-embed-rxiv}
WATCHDOG_MIN=${WATCHDOG_MIN:-300}
AMI=${AMI:-ami-012ba162b9cd2729c}
DRYRUN=${DRYRUN:-}
EXPECT_HOST=${EXPECT_HOST:-ep-orange-water-aut2eymf}
RUN_ID=${RUN_ID:-$(date +%Y%m%d-%H%M%S)-classify}
run() { if [ -n "$DRYRUN" ]; then echo "  [dry-run] would run: $*"; else "$@"; fi; }
echo "run_id: $RUN_ID  out: s3://$BUCKET/models/cshl-classify/$RUN_ID/"

# 1. DB url -> SSM (needed only by the kNN baseline arm). Endpoint fence first.
DBVAL=$(grep "^${DBURL_ENV:-DATABASE_URL_UNPOOLED}=" .env.local | head -1 | cut -d= -f2- | sed "s/^['\"]//;s/['\"]$//")
[ -n "$DBVAL" ] || { echo "no DB url in env ${DBURL_ENV:-DATABASE_URL_UNPOOLED}"; exit 1; }
DBHOST=$(printf '%s' "$DBVAL" | sed -E 's#^[^@]+@([^/?]+).*#\1#')
case "$DBHOST" in "$EXPECT_HOST".*) echo "db endpoint: $EXPECT_HOST (fence ok)";;
  *) echo "FENCE FAIL: endpoint is '$DBHOST', expected '$EXPECT_HOST.*' — refusing." >&2; exit 1;; esac
if [ -n "$DRYRUN" ]; then echo "  [dry-run] would run: aws ssm put-parameter --name $PARAM --value <redacted> --overwrite"
else aws ssm put-parameter --name $PARAM --type SecureString --value "$DBVAL" --overwrite --region $REGION >/dev/null; echo "ssm param set: $PARAM"; fi

# 2. IAM — reuse the embed rig's role, refresh idempotently. models/* already covers
#    models/cshl-classify/*; classify/* is added for the slice pull and predictions.
if [ -z "$DRYRUN" ] && ! aws iam get-role --role-name $ROLE >/dev/null 2>&1; then
  echo "role $ROLE does not exist — run scripts/embed-nsr/launch.sh once first"; exit 1
fi
run aws iam put-role-policy --role-name $ROLE --policy-name read-dburl --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"ssm:GetParameter\",\"Resource\":\"arn:aws:ssm:$REGION:*:parameter$PARAM\"},{\"Effect\":\"Allow\",\"Action\":\"s3:GetObject\",\"Resource\":\"arn:aws:s3:::$BUCKET/*\"},{\"Effect\":\"Allow\",\"Action\":[\"s3:ListBucket\",\"s3:GetBucketLocation\"],\"Resource\":\"arn:aws:s3:::$BUCKET\"},{\"Effect\":\"Allow\",\"Action\":\"s3:PutObject\",\"Resource\":[\"arn:aws:s3:::$BUCKET/logs/*\",\"arn:aws:s3:::$BUCKET/models/*\",\"arn:aws:s3:::$BUCKET/classify/*\"]}]}"

# 3. worker + slices to S3
if [ -z "$DRYRUN" ]; then
  aws s3 cp scripts/classify/classify.py "s3://$BUCKET/classify/$RUN_ID/classify.py" --only-show-errors
  aws s3 cp scripts/classify/run.sh      "s3://$BUCKET/classify/$RUN_ID/run.sh" --only-show-errors
  echo "worker uploaded: s3://$BUCKET/classify/$RUN_ID/"
  for f in category.labels.json mesh.labels.json slices-manifest.json; do
    aws s3api head-object --bucket $BUCKET --key "classify/$RUN_ID/data/$f" >/dev/null 2>&1 \
      || { echo "s3://$BUCKET/classify/$RUN_ID/data/$f missing — run scripts/classify/upload-slices.sh RUN_ID=$RUN_ID first"; exit 1; }
  done
else
  echo "  [dry-run] would upload classify.py + run.sh -> s3://$BUCKET/classify/$RUN_ID/"
  echo "  [dry-run] would require s3://$BUCKET/classify/$RUN_ID/data/{category,mesh}.labels.json + slices-manifest.json"
fi

# 4. SG
if [ -z "$DRYRUN" ]; then
  VPC=$(aws ec2 describe-vpcs --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId' --output text --region $REGION)
  SG=$(aws ec2 describe-security-groups --filters Name=group-name,Values=$SG_NAME Name=vpc-id,Values=$VPC --query 'SecurityGroups[0].GroupId' --output text --region $REGION)
  [ "$SG" != "None" ] || { echo "sg $SG_NAME not found"; exit 1; }
else SG='<sg-dryrun>'; fi
echo "sg: $SG  ami: $AMI"

UD=$(cat <<EOUD
#!/bin/bash
exec > /var/log/classify.log 2>&1
set -x
shutdown -h +$WATCHDOG_MIN
export AWS_DEFAULT_REGION=$REGION
# xtrace OFF across the credential: the NSR embed rig leaked a live Neon URL into
# three uploaded S3 logs exactly this way.
set +x
DBURL=\$(aws ssm get-parameter --name $PARAM --with-decryption --query Parameter.Value --output text)
aws s3 cp s3://$BUCKET/classify/$RUN_ID/run.sh /root/run.sh
chmod +x /root/run.sh
export RUN_ID=$RUN_ID BUCKET=$BUCKET
export BASE_MODEL="${BASE_MODEL:-answerdotai/ModernBERT-base}" MAX_LEN=${MAX_LEN:-1024} BATCH=${BATCH:-32}
export CAT_EPOCHS=${CAT_EPOCHS:-2} MESH_EPOCHS=${MESH_EPOCHS:-3} LR=${LR:-3e-5} SAVE_STEPS=${SAVE_STEPS:-500}
export SKIP_SMOKE=${SKIP_SMOKE:-0} ${ONLY_TASK:+ONLY_TASK=$ONLY_TASK}
${RESUME_CATEGORY:+export RESUME_CATEGORY=$RESUME_CATEGORY}
${RESUME_MESH:+export RESUME_MESH=$RESUME_MESH}
DATABASE_URL="\$DBURL" /root/run.sh
RC=\$?
set -x
aws s3 cp /var/log/classify.log s3://$BUCKET/logs/cshl-classify-$RUN_ID.log
echo "run.sh exited \$RC"
shutdown -h now
EOUD
)

IFS=',' read -r -a TYPES <<< "$TYPE_MENU"
if [ -n "$DRYRUN" ]; then
  echo "───── dry-run: user-data ─────"; echo "$UD"; echo "───── end ─────"
  for t in "${TYPES[@]}"; do echo "  [dry-run] would try $t across every offered AZ, then fall through"; done
  exit 0
fi

# 5. TYPE_MENU walk. `|| true` on the assignment is load-bearing: under `set -e` a
#    capacity error inside a command substitution kills the whole script, so the
#    loop whose only job is "try the next AZ" could never reach iteration two.
launch_in() {
  local type="$1" subnet="$2"
  aws ec2 run-instances --region $REGION \
    --image-id "$AMI" --instance-type "$type" --count 1 \
    ${subnet:+--subnet-id "$subnet"} \
    --iam-instance-profile Name=$ROLE --security-group-ids "$SG" \
    --instance-initiated-shutdown-behavior terminate \
    --block-device-mappings '[{"DeviceName":"/dev/sda1","Ebs":{"VolumeSize":200,"VolumeType":"gp3","DeleteOnTermination":true}}]' \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=cshl-classify-$RUN_ID},{Key=InstanceType,Value=$type}]" \
    --user-data "$UD" --query 'Instances[0].InstanceId' --output text 2>&1
}
FAKE_CAPACITY_FAIL=${FAKE_CAPACITY_FAIL:-}
if [ -n "$FAKE_CAPACITY_FAIL" ]; then
  FAKE_N="${FAKE_CAPACITY_FAIL%%:*}"; FAKE_SUCCEED_ID=""
  case "$FAKE_CAPACITY_FAIL" in *:*) FAKE_SUCCEED_ID="${FAKE_CAPACITY_FAIL#*:}";; esac
  FAKE_COUNTER_FILE=$(mktemp); echo 0 > "$FAKE_COUNTER_FILE"
  launch_in() {
    local calls; calls=$(($(cat "$FAKE_COUNTER_FILE") + 1)); echo "$calls" > "$FAKE_COUNTER_FILE"
    if [ "$calls" -le "$FAKE_N" ]; then
      echo "An error occurred (InsufficientInstanceCapacity) when calling the RunInstances operation (FAKE #$calls: $1 in ${2:-<no-subnet>})"
    elif [ -n "$FAKE_SUCCEED_ID" ]; then echo "$FAKE_SUCCEED_ID"
    else echo "An error occurred (InsufficientInstanceCapacity) when calling the RunInstances operation (FAKE #$calls: $1)"; fi
  }
fi

ID=""; PICKED_TYPE=""
for TYPE in "${TYPES[@]}"; do
  if [ -n "${SUBNET:-}" ]; then CANDIDATES="$SUBNET"; else
    OFFERED=$(aws ec2 describe-instance-type-offerings --region $REGION --location-type availability-zone \
      --filters Name=instance-type,Values=$TYPE --query 'InstanceTypeOfferings[].Location' --output text)
    CANDIDATES=""
    for az in $OFFERED; do
      sn=$(aws ec2 describe-subnets --region $REGION --filters Name=vpc-id,Values=$VPC Name=availability-zone,Values=$az \
             --query 'Subnets[0].SubnetId' --output text)
      [ "$sn" != "None" ] && CANDIDATES="$CANDIDATES $sn"
    done
  fi
  [ -n "$CANDIDATES" ] || { echo "type $TYPE: not offered in any AZ with a subnet — next type"; continue; }
  for sn in $CANDIDATES; do
    OUT=$(launch_in "$TYPE" "$sn") || true
    case "$OUT" in
      i-*) ID="$OUT"; PICKED_TYPE="$TYPE"; echo "launched: $ID ($TYPE, $sn)"; break 2 ;;
      *InsufficientInstanceCapacity*|*Unsupported*) echo "type $TYPE: no capacity in $sn — next AZ" ;;
      *) echo "type $TYPE: launch failed in $sn (non-capacity) — next type: $OUT"; break ;;
    esac
  done
done
[ -n "$ID" ] || { echo "NO CAPACITY FOR ANY TYPE IN MENU: $TYPE_MENU. Nothing launched." >&2; exit 1; }
echo "$ID $PICKED_TYPE"
