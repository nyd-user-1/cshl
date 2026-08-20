#!/usr/bin/env bash
# Delete every resource this experiment creates. Idempotent: safe to run twice,
# safe to run when nothing exists. Written BEFORE anything billable was created.
#
#   ./scripts/kb/teardown.sh          # delete everything
#   KEEP_DOCS=1 ./scripts/kb/teardown.sh   # keep the S3 source docs (pennies)
set -uo pipefail
source "$(dirname "$0")/env.sh"
say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

say "0. AgentCore harnesses + gateway"
for h in CshlPubStatusClerk CshlRelatedWork; do
  HID=$(aws bedrock-agentcore-control list-harnesses --region "$AWS_REGION" \
        --query "harnesses[?harnessName=='$h'].harnessId | [0]" --output text 2>/dev/null)
  if [ -n "$HID" ] && [ "$HID" != "None" ]; then
    aws bedrock-agentcore-control delete-harness --region "$AWS_REGION" --harness-id "$HID" >/dev/null 2>&1 \
      && echo "  harness $h ($HID): deleted" || echo "  harness $h ($HID): delete failed"
  else echo "  harness $h: absent"; fi
done
GWID=$(aws bedrock-agentcore-control list-gateways --region "$AWS_REGION" \
       --query "items[?name=='cshl-kb-gateway'].gatewayId | [0]" --output text 2>/dev/null)
if [ -n "$GWID" ] && [ "$GWID" != "None" ]; then
  for T in $(aws bedrock-agentcore-control list-gateway-targets --region "$AWS_REGION" \
              --gateway-identifier "$GWID" --query 'items[].targetId' --output text 2>/dev/null); do
    aws bedrock-agentcore-control delete-gateway-target --region "$AWS_REGION" \
      --gateway-identifier "$GWID" --target-id "$T" >/dev/null 2>&1 && echo "  target $T: deleted"
  done
  sleep 5
  aws bedrock-agentcore-control delete-gateway --region "$AWS_REGION" --gateway-identifier "$GWID" >/dev/null 2>&1 \
    && echo "  gateway $GWID: deleted" || echo "  gateway $GWID: delete failed"
else echo "  cshl-kb-gateway: absent"; fi

say "1. Bedrock agents (classic - unused, service is in maintenance mode)"
for a in "$AGENT1_NAME" "$AGENT2_NAME"; do
  ID=$(aws bedrock-agent list-agents --region "$AWS_REGION" \
        --query "agentSummaries[?agentName=='$a'].agentId | [0]" --output text 2>/dev/null)
  [ "$ID" = "None" ] || [ -z "$ID" ] && { echo "  $a: absent"; continue; }
  aws bedrock-agent delete-agent --region "$AWS_REGION" --agent-id "$ID" --skip-resource-in-use-check >/dev/null 2>&1 \
    && echo "  $a ($ID): deleted" || echo "  $a ($ID): delete failed"
done

say "2. Lambda functions"
for f in "$LAMBDA1" "$LAMBDA2"; do
  aws lambda delete-function --region "$AWS_REGION" --function-name "$f" >/dev/null 2>&1 \
    && echo "  $f: deleted" || echo "  $f: absent"
done

say "3. Knowledge base (data sources go with it)"
KBID=$(aws bedrock-agent list-knowledge-bases --region "$AWS_REGION" \
        --query "knowledgeBaseSummaries[?name=='$KB_NAME'].knowledgeBaseId | [0]" --output text 2>/dev/null)
if [ -n "$KBID" ] && [ "$KBID" != "None" ]; then
  for DSID in $(aws bedrock-agent list-data-sources --region "$AWS_REGION" --knowledge-base-id "$KBID" \
                 --query 'dataSourceSummaries[].dataSourceId' --output text 2>/dev/null); do
    aws bedrock-agent delete-data-source --region "$AWS_REGION" --knowledge-base-id "$KBID" \
      --data-source-id "$DSID" >/dev/null 2>&1 && echo "  data source $DSID: deleted"
  done
  aws bedrock-agent delete-knowledge-base --region "$AWS_REGION" --knowledge-base-id "$KBID" >/dev/null 2>&1 \
    && echo "  KB $KBID: deleted" || echo "  KB $KBID: delete failed"
else
  echo "  $KB_NAME: absent"
fi

say "4. S3 Vectors index + bucket  (THE ONLY ONGOING CHARGE)"
aws s3vectors delete-index --region "$AWS_REGION" --vector-bucket-name "$VEC_BUCKET" \
  --index-name "$VEC_INDEX" >/dev/null 2>&1 && echo "  index $VEC_INDEX: deleted" || echo "  index $VEC_INDEX: absent"
aws s3vectors delete-vector-bucket --region "$AWS_REGION" --vector-bucket-name "$VEC_BUCKET" >/dev/null 2>&1 \
  && echo "  vector bucket $VEC_BUCKET: deleted" || echo "  vector bucket $VEC_BUCKET: absent"

say "5. S3 source documents"
if [ "${KEEP_DOCS:-0}" = "1" ]; then echo "  kept (KEEP_DOCS=1)"; else
  aws s3 rm "s3://$DOC_BUCKET" --recursive --region "$AWS_REGION" >/dev/null 2>&1
  aws s3api delete-bucket --bucket "$DOC_BUCKET" --region "$AWS_REGION" >/dev/null 2>&1 \
    && echo "  $DOC_BUCKET: deleted" || echo "  $DOC_BUCKET: absent"
fi

say "6. IAM roles"
for r in "$KB_ROLE" "$AGENT_ROLE" cshl-kb-gateway-role cshl-kb-harness-role; do
  for p in $(aws iam list-role-policies --role-name "$r" --query 'PolicyNames[]' --output text 2>/dev/null); do
    aws iam delete-role-policy --role-name "$r" --policy-name "$p" >/dev/null 2>&1
  done
  for p in $(aws iam list-attached-role-policies --role-name "$r" --query 'AttachedPolicies[].PolicyArn' --output text 2>/dev/null); do
    aws iam detach-role-policy --role-name "$r" --policy-arn "$p" >/dev/null 2>&1
  done
  aws iam delete-role --role-name "$r" >/dev/null 2>&1 && echo "  $r: deleted" || echo "  $r: absent"
done

say "Teardown complete. Verify:"
echo "  aws s3vectors list-vector-buckets --region $AWS_REGION"
echo "  aws bedrock-agent list-knowledge-bases --region $AWS_REGION"
