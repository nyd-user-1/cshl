#!/bin/bash
# embed-nsr launcher — adapted from 44b scripts/embed-v2/launch.sh (renames +
# computed lane bounds). N× g6e.xlarge (1 L40S each; quota is 16 vCPUs = 4 max),
# DLAMI base, TEI (bge-m3) + worker via user-data, self-terminating.
# DB URL travels .env.local → SSM SecureString → instance at boot; never in
# user-data plaintext, never echoed.
#
# Usage (run from repo root):
#   REHEARSE=3000 REHEARSE_LO=2010 N=1 ./scripts/embed-nsr/launch.sh   # 1% rehearsal
#   N=1 ./scripts/embed-nsr/launch.sh                                   # full run
set -euo pipefail
REGION=us-east-1
N=${N:-1}
TYPE=${TYPE:-g6e.xlarge}
PARAM=/nsr/embed/dburl
ROLE=nsr-embed
SG_NAME=nsr-embed-sg
BUCKET=nsr-embed-v2
LANES_UD=${LANES_UD:-4}

# 1. DB url into SSM (SecureString) from .env.local, never echoed
DBVAL=$(grep "^${DBURL_ENV:-DATABASE_URL_UNPOOLED}=" .env.local | head -1 | cut -d= -f2- | sed "s/^['\"]//;s/['\"]$//")
[ -n "$DBVAL" ] || { echo "no DB url in env ${DBURL_ENV:-DATABASE_URL_UNPOOLED}"; exit 1; }
aws ssm put-parameter --name $PARAM --type SecureString --value "$DBVAL" --overwrite --region $REGION >/dev/null
echo "ssm param set: $PARAM"

# 2. IAM role + instance profile (SSM core for debugging + read the one param)
if ! aws iam get-role --role-name $ROLE >/dev/null 2>&1; then
  aws iam create-role --role-name $ROLE --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
  aws iam attach-role-policy --role-name $ROLE --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
  aws iam put-role-policy --role-name $ROLE --policy-name read-dburl --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"ssm:GetParameter\",\"Resource\":\"arn:aws:ssm:$REGION:*:parameter$PARAM\"},{\"Effect\":\"Allow\",\"Action\":\"s3:GetObject\",\"Resource\":\"arn:aws:s3:::$BUCKET/*\"}]}"
  aws iam create-instance-profile --instance-profile-name $ROLE >/dev/null
  aws iam add-role-to-instance-profile --instance-profile-name $ROLE --role-name $ROLE
  echo "iam role created; waiting for propagation"; sleep 12
fi
# policy refresh is idempotent: read the one param, fetch worker, upload run log
aws iam put-role-policy --role-name $ROLE --policy-name read-dburl --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"ssm:GetParameter\",\"Resource\":\"arn:aws:ssm:$REGION:*:parameter$PARAM\"},{\"Effect\":\"Allow\",\"Action\":\"s3:GetObject\",\"Resource\":\"arn:aws:s3:::$BUCKET/*\"},{\"Effect\":\"Allow\",\"Action\":\"s3:PutObject\",\"Resource\":\"arn:aws:s3:::$BUCKET/logs/*\"}]}"

# 3. Worker to S3 (bucket created on first run)
aws s3api head-bucket --bucket $BUCKET 2>/dev/null || aws s3 mb s3://$BUCKET --region $REGION >/dev/null
aws s3 cp scripts/embed-nsr/worker.mjs s3://$BUCKET/worker.mjs >/dev/null
echo "worker uploaded: s3://$BUCKET/worker.mjs"

# 4. Security group — egress only, zero ingress
VPC=$(aws ec2 describe-vpcs --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId' --output text --region $REGION)
SG=$(aws ec2 describe-security-groups --filters Name=group-name,Values=$SG_NAME Name=vpc-id,Values=$VPC --query 'SecurityGroups[0].GroupId' --output text --region $REGION)
if [ "$SG" = "None" ]; then
  SG=$(aws ec2 create-security-group --group-name $SG_NAME --description "nsr embed egress-only" --vpc-id $VPC --query GroupId --output text --region $REGION)
fi
echo "sg: $SG"

# 5. Latest DLAMI base (OSS NVIDIA driver, Ubuntu 22.04)
AMI=$(aws ssm get-parameter --name /aws/service/deeplearning/ami/x86_64/base-oss-nvidia-driver-gpu-ubuntu-22.04/latest/ami-id --query Parameter.Value --output text --region $REGION)
echo "ami: $AMI"

# 6. Lane bounds, computed from the unembedded set at launch time.
#    L = N*LANES upper-boundary keys (last = global cap), so a rehearsal is
#    bounded above and the full run claims exactly what remains.
#    REHEARSE=<rows> limits the claim set; REHEARSE_LO picks its key prefix.
L=$((N * LANES_UD))
FILTER=""; LIMIT="rn <= 1000000000"
[ -n "${REHEARSE:-}" ] && { FILTER="AND n.key_number >= '${REHEARSE_LO:-2010}'"; LIMIT="rn <= ${REHEARSE}"; }
BOUNDS=$(psql "$DBVAL" -X -q -t -A -c "
WITH todo AS (
  SELECT n.key_number, row_number() OVER (ORDER BY n.key_number) AS rn
    FROM nsr n LEFT JOIN nsr_embeddings e ON e.key_number = n.key_number
   WHERE e.key_number IS NULL
     AND length(regexp_replace(coalesce(n.title,'') || coalesce(n.abstract,''), '\s+', '', 'g')) >= 20
     $FILTER
), lim AS (SELECT * FROM todo WHERE $LIMIT),
   t AS (SELECT max(rn) AS total FROM lim)
SELECT string_agg(key_number, ',' ORDER BY rn) FROM lim
 WHERE rn IN (SELECT (total * k) / $L FROM t, generate_series(1, $L) k)")
[ -n "$BOUNDS" ] || { echo "no bounds — nothing unembedded?"; exit 1; }
echo "bounds ($L lanes): $BOUNDS"

# 7. Launch one box per partition (START to launch a single straggler)
for i in $(seq ${START:-0} $((N-1))); do
  UD=$(cat <<EOF
#!/bin/bash
exec > /var/log/embed.log 2>&1
set +x  # never trace: DB URL from SSM would land in the uploaded log
shutdown -h +120   # watchdog: nothing runs past 2h
export AWS_DEFAULT_REGION=$REGION
DBURL=\$(aws ssm get-parameter --name $PARAM --with-decryption --query Parameter.Value --output text)
docker run -d --gpus all -p 8080:80 --name tei ghcr.io/huggingface/text-embeddings-inference:89-1.8 \
  --model-id BAAI/bge-m3 --dtype float16 --max-client-batch-size 256 --max-batch-tokens 131072
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs
mkdir -p /opt/embed && cd /opt/embed && npm init -y >/dev/null && npm i pg >/dev/null
aws s3 cp s3://$BUCKET/worker.mjs worker.mjs
for t in \$(seq 1 60); do curl -sf http://127.0.0.1:8080/health && break; sleep 5; done
export PART=$i PARTS=$N PAGE=${PAGE:-1024} LANES=$LANES_UD
export BOUNDS_NSR='$BOUNDS' LO_CAP='${REHEARSE:+${REHEARSE_LO:-2010}}'
DATABASE_URL="\$DBURL" node worker.mjs
aws s3 cp /var/log/embed.log s3://$BUCKET/logs/nsr-embed-part$i-\$(date +%s).log
shutdown -h now
EOF
)
  aws ec2 run-instances --region $REGION \
    --image-id "$AMI" --instance-type $TYPE --count 1 \
    ${SUBNET:+--subnet-id $SUBNET} \
    --iam-instance-profile Name=$ROLE \
    --security-group-ids "$SG" \
    --instance-initiated-shutdown-behavior terminate \
    --block-device-mappings '[{"DeviceName":"/dev/sda1","Ebs":{"VolumeSize":100,"VolumeType":"gp3","DeleteOnTermination":true}}]' \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=nsr-embed-$i}]" \
    --user-data "$UD" \
    --query 'Instances[0].InstanceId' --output text
done
