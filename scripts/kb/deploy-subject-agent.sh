#!/usr/bin/env bash
# deploy-subject-agent.sh — an AgentCore harness for ONE subject, patterned
# exactly on CshlPubStatusClerk/CshlRelatedWork (docs/AGENTCORE-CSHL-AGENTS.md
# on lane/bedrock-kb): harness → cshl-kb-gateway (MCP, AWS_IAM) → lambda.
#
# The new lambda (cshl-kb-subjectsearch) calls the live site's /api/search with
# the subject scope, so the agent retrieves through OUR fine-tuned stack. The
# harness also inherits the gateway's existing tools (publication status,
# related work) — one gateway, three tools, per-subject prompts.
#
#   scripts/kb/deploy-subject-agent.sh "infectious diseases" medrxiv
set -euo pipefail
CATEGORY="${1:?usage: deploy-subject-agent.sh <category> <server>}"
SERVER="${2:?usage: deploy-subject-agent.sh <category> <server>}"
AWS_REGION=us-east-1
ACCOUNT_ID=638175140432
GATEWAY_ID=cshl-kb-gateway-ydn5tqpavx
GATEWAY_ARN="arn:aws:bedrock-agentcore:${AWS_REGION}:${ACCOUNT_ID}:gateway/${GATEWAY_ID}"
HARNESS_ROLE="arn:aws:iam::${ACCOUNT_ID}:role/cshl-kb-harness-role"
LAMBDA_ROLE="arn:aws:iam::${ACCOUNT_ID}:role/cshl-kb-agent-role"
LAMBDA=cshl-kb-subjectsearch
MODEL="us.anthropic.claude-haiku-4-5-20251001-v1:0"
# "Infectious Diseases" → CshlInfectiousDiseases
TITLE=$(python3 -c "import sys; print(''.join(w.capitalize() for w in sys.argv[1].split()))" "$CATEGORY")
HARNESS="Cshl${TITLE}"

cd "$(dirname "$0")/../.."

# ── 1. lambda ───────────────────────────────────────────────────────────────
ZIP=/tmp/${LAMBDA}.zip; rm -f "$ZIP"
( cd scripts/kb/agents/subjectsearch && zip -qr "$ZIP" . )
if aws lambda get-function --region "$AWS_REGION" --function-name "$LAMBDA" >/dev/null 2>&1; then
  aws lambda update-function-code --region "$AWS_REGION" --function-name "$LAMBDA" --zip-file "fileb://$ZIP" >/dev/null
else
  aws lambda create-function --region "$AWS_REGION" --function-name "$LAMBDA" \
    --runtime nodejs22.x --role "$LAMBDA_ROLE" --handler index.handler \
    --timeout 30 --memory-size 256 --zip-file "fileb://$ZIP" >/dev/null
fi
aws lambda wait function-updated --region "$AWS_REGION" --function-name "$LAMBDA"
aws lambda add-permission --region "$AWS_REGION" --function-name "$LAMBDA" \
  --statement-id agentcore-gw --action lambda:InvokeFunction \
  --principal bedrock-agentcore.amazonaws.com \
  --source-account "$ACCOUNT_ID" >/dev/null 2>&1 || true
echo "lambda $LAMBDA ready"

# ── 2. gateway target (idempotent by name) ──────────────────────────────────
EXISTING=$(aws bedrock-agentcore-control list-gateway-targets --region "$AWS_REGION" \
  --gateway-identifier "$GATEWAY_ID" \
  --query "items[?name=='cshl-subjectsearch'].targetId | [0]" --output text)
if [ "$EXISTING" = "None" ] || [ -z "$EXISTING" ]; then
  aws bedrock-agentcore-control create-gateway-target --region "$AWS_REGION" \
    --gateway-identifier "$GATEWAY_ID" --name cshl-subjectsearch \
    --target-configuration "{\"mcp\":{\"lambda\":{\"lambdaArn\":\"arn:aws:lambda:${AWS_REGION}:${ACCOUNT_ID}:function:${LAMBDA}\",\"toolSchema\":{\"inlinePayload\":[{\"name\":\"search_preprints\",\"description\":\"Search the CSHL preprint corpus (bioRxiv + medRxiv, 433k papers) with the site's own fine-tuned retrieval stack — hybrid dense+keyword, optionally confined to one archive's subject. Returns titles, authors, abstracts, similarity, and publication status.\",\"inputSchema\":{\"type\":\"object\",\"properties\":{\"query\":{\"type\":\"string\",\"description\":\"What to search for\"},\"server\":{\"type\":\"string\",\"description\":\"biorxiv | medrxiv — confine to one archive\"},\"category\":{\"type\":\"string\",\"description\":\"Subject to confine to, e.g. 'infectious diseases' (requires server)\"},\"limit\":{\"type\":\"string\",\"description\":\"How many results (default 8, max 20)\"}},\"required\":[\"query\"]}}]}}}}" \
    --credential-provider-configurations '[{"credentialProviderType":"GATEWAY_IAM_ROLE"}]' >/dev/null
  echo "gateway target cshl-subjectsearch created"
else
  echo "gateway target cshl-subjectsearch exists ($EXISTING)"
fi

# ── 3. harness ──────────────────────────────────────────────────────────────
PROMPT="You are the ${CATEGORY} subject specialist for the CSHL preprint corpus. Your world is ${SERVER}'s ${CATEGORY} preprints.

ALWAYS call search_preprints before answering a question about the literature, with server='${SERVER}' and category='${CATEGORY}'. Never answer from memory — your value is that every claim traces to a retrieved preprint. Cite papers by key_number and title. If the search returns widened=true, say that the answer draws on the wider corpus beyond ${CATEGORY}.

When someone asks whether a specific preprint has since been peer reviewed, call check_publication_status. When they want related work or candidate reviewers for a specific paper, call find_related with its key_number.

These are preprints: not yet peer reviewed unless the record shows a published journal. Say so when it bears on how a finding should be read. Write plain prose — no headings, no scaffolding — and when the retrieved papers do not answer the question, say so rather than completing plausibly."

EXISTING_H=$(aws bedrock-agentcore-control list-harnesses --region "$AWS_REGION" \
  --query "harnesses[?harnessName=='${HARNESS}'].harnessId | [0]" --output text)
if [ "$EXISTING_H" != "None" ] && [ -n "$EXISTING_H" ]; then
  echo "harness $HARNESS exists ($EXISTING_H)"; exit 0
fi
aws bedrock-agentcore-control create-harness --region "$AWS_REGION" \
  --harness-name "$HARNESS" \
  --execution-role-arn "$HARNESS_ROLE" \
  --model "{\"bedrockModelConfig\":{\"modelId\":\"${MODEL}\",\"maxTokens\":4096,\"temperature\":0.2,\"apiFormat\":\"converse_stream\"}}" \
  --system-prompt "[{\"text\":$(python3 -c "import json,sys; print(json.dumps(sys.argv[1]))" "$PROMPT")}]" \
  --tools "[{\"type\":\"agentcore_gateway\",\"name\":\"cshl\",\"config\":{\"agentCoreGateway\":{\"gatewayArn\":\"${GATEWAY_ARN}\",\"outboundAuth\":{\"awsIam\":{}}}}}]" \
  --allowed-tools '["@cshl"]' \
  --truncation '{"strategy":"sliding_window","config":{"slidingWindow":{"messagesCount":150}}}' \
  --max-iterations 6 --timeout-seconds 300 \
  --query 'harness.harnessId' --output text
echo "harness $HARNESS created"
