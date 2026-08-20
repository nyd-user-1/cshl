#!/usr/bin/env bash
# deploy-agents.sh — two Bedrock agents over the two Lambdas in agents/.
#
# NOTE ON THE DB CREDENTIAL: the relatedwork Lambda needs DATABASE_URL. It is set
# as a Lambda environment variable (encrypted at rest). That is adequate for this
# experiment and NOT adequate long term — the handoff already carries an open
# "rotate the Neon password" item. Secrets Manager is the right home; called out
# rather than quietly done, because rotating a shared credential is not this
# lane's call to make.
set -euo pipefail
source "$(dirname "$0")/env.sh"
cd "$(git rev-parse --show-toplevel)"
DB_URL=$(grep '^DATABASE_URL=' .env.local | head -1 | cut -d= -f2- | tr -d '"')

# ── lambda execution role ───────────────────────────────────────────────────
if ! aws iam get-role --role-name "$AGENT_ROLE" >/dev/null 2>&1; then
  aws iam create-role --role-name "$AGENT_ROLE" --assume-role-policy-document \
    '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
  aws iam attach-role-policy --role-name "$AGENT_ROLE" \
    --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
  echo "waiting for role propagation…"; sleep 12
fi
LROLE="arn:aws:iam::${ACCOUNT_ID}:role/${AGENT_ROLE}"

# ── package + deploy the two functions ──────────────────────────────────────
deploy_fn() {  # $1 dir  $2 name  $3 needs_neon  $4 timeout
  local dir="scripts/kb/agents/$1" name="$2" zip="/tmp/$2.zip"
  rm -f "$zip"; ( cd "$dir" && rm -rf node_modules
    if [ "$3" = "yes" ]; then mkdir -p node_modules/@neondatabase
      cp -R "$(git rev-parse --show-toplevel)/node_modules/@neondatabase/serverless" node_modules/@neondatabase/; fi
    zip -qr "$zip" . )
  if aws lambda get-function --region "$AWS_REGION" --function-name "$name" >/dev/null 2>&1; then
    aws lambda update-function-code --region "$AWS_REGION" --function-name "$name" --zip-file "fileb://$zip" >/dev/null
  else
    aws lambda create-function --region "$AWS_REGION" --function-name "$name" \
      --runtime nodejs22.x --role "$LROLE" --handler index.handler --timeout "$4" --memory-size 512 \
      --zip-file "fileb://$zip" >/dev/null
  fi
  if [ "$3" = "yes" ]; then
    aws lambda wait function-updated --region "$AWS_REGION" --function-name "$name"
    aws lambda update-function-configuration --region "$AWS_REGION" --function-name "$name" \
      --environment "Variables={DATABASE_URL=$DB_URL}" >/dev/null
  fi
  aws lambda wait function-updated --region "$AWS_REGION" --function-name "$name"
  echo "  lambda $name ready"
}
echo "deploying lambdas…"
deploy_fn pubstatus   "$LAMBDA1" no  30
deploy_fn relatedwork "$LAMBDA2" yes 60

# ── bedrock agent service role ──────────────────────────────────────────────
BR_ROLE="cshl-kb-role"   # reuse: same account, already trusted by bedrock
aws iam put-role-policy --role-name "$BR_ROLE" --policy-name agent-invoke --policy-document \
  "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":[\"bedrock:InvokeModel\",\"bedrock:InvokeModelWithResponseStream\",\"bedrock:GetInferenceProfile\",\"bedrock:GetFoundationModel\"],\"Resource\":[\"arn:aws:bedrock:*::foundation-model/*\",\"arn:aws:bedrock:${AWS_REGION}:${ACCOUNT_ID}:inference-profile/*\"]},{\"Effect\":\"Allow\",\"Action\":[\"bedrock:Retrieve\",\"bedrock:RetrieveAndGenerate\"],\"Resource\":\"arn:aws:bedrock:${AWS_REGION}:${ACCOUNT_ID}:knowledge-base/*\"}]}"
# widen the trust policy: the same role is now assumed for agents as well as KBs
aws iam update-assume-role-policy --role-name "$BR_ROLE" --policy-document \
  "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Principal\":{\"Service\":\"bedrock.amazonaws.com\"},\"Action\":\"sts:AssumeRole\",\"Condition\":{\"StringEquals\":{\"aws:SourceAccount\":\"${ACCOUNT_ID}\"}}}]}"
AROLE="arn:aws:iam::${ACCOUNT_ID}:role/${BR_ROLE}"
sleep 8

make_agent() {  # $1 name  $2 instruction  $3 lambda  $4 function-schema-json
  local id
  id=$(aws bedrock-agent list-agents --region "$AWS_REGION" --query "agentSummaries[?agentName=='$1'].agentId | [0]" --output text)
  if [ "$id" = "None" ] || [ -z "$id" ]; then
    id=$(aws bedrock-agent create-agent --region "$AWS_REGION" --agent-name "$1" \
      --agent-resource-role-arn "$AROLE" --foundation-model "$GEN_MODEL" \
      --instruction "$2" --idle-session-ttl-in-seconds 600 \
      --query 'agent.agentId' --output text)
    sleep 8
  fi
  echo "$id" > "$STATE_DIR/${1}_agent_id"
  aws lambda add-permission --region "$AWS_REGION" --function-name "$3" \
    --statement-id "bedrock-$1" --action lambda:InvokeFunction --principal bedrock.amazonaws.com \
    --source-arn "arn:aws:bedrock:${AWS_REGION}:${ACCOUNT_ID}:agent/${id}" >/dev/null 2>&1 || true
  local agid
  agid=$(aws bedrock-agent list-agent-action-groups --region "$AWS_REGION" --agent-id "$id" --agent-version DRAFT \
          --query "actionGroupSummaries[?actionGroupName=='tools'].actionGroupId | [0]" --output text 2>/dev/null || echo None)
  if [ "$agid" = "None" ] || [ -z "$agid" ]; then
    aws bedrock-agent create-agent-action-group --region "$AWS_REGION" --agent-id "$id" --agent-version DRAFT \
      --action-group-name tools --action-group-executor "{\"lambda\":\"arn:aws:lambda:${AWS_REGION}:${ACCOUNT_ID}:function:$3\"}" \
      --function-schema "$4" --action-group-state ENABLED >/dev/null
  fi
  aws bedrock-agent prepare-agent --region "$AWS_REGION" --agent-id "$id" >/dev/null
  sleep 10
  local alias
  alias=$(aws bedrock-agent list-agent-aliases --region "$AWS_REGION" --agent-id "$id" \
           --query "agentAliasSummaries[?agentAliasName=='live'].agentAliasId | [0]" --output text)
  if [ "$alias" = "None" ] || [ -z "$alias" ]; then
    alias=$(aws bedrock-agent create-agent-alias --region "$AWS_REGION" --agent-id "$id" --agent-alias-name live \
             --query 'agentAlias.agentAliasId' --output text)
  fi
  echo "$alias" > "$STATE_DIR/${1}_alias_id"
  echo "  agent $1: $id alias $alias"
}

echo "creating agents…"
make_agent "$AGENT1_NAME" \
"You are a publication-status clerk for the CSHL preprint corpus (bioRxiv/medRxiv). Given a preprint, your ONE job is to determine whether it has since appeared in the peer-reviewed literature, and to say so precisely.

Always call check_publication_status before answering. Never answer from memory: our own corpus records publication status for only about half of its rows, and a preprint that was retitled on acceptance looks unpublished to every naive check.

Report the journal, the published DOI, and the date. If the tool reports retitled=true, say the title changed and give both titles — that is the case people get wrong. If the tool finds nothing, say the check was INCONCLUSIVE. Do not assert that a paper is unpublished; absence of a Crossref match is not evidence of absence, and a confident 'not peer reviewed' is the specific error this clerk exists to prevent." \
  "$LAMBDA1" \
  '{"functions":[{"name":"check_publication_status","description":"Check whether a preprint has been published in a peer-reviewed journal, by bibliographic match on title plus author surnames (NOT by DOI relation, which misses retitled papers).","parameters":{"title":{"type":"string","description":"The preprint title","required":true},"authors":{"type":"string","description":"Semicolon-separated author list, e.g. \"Vink, J. N.; Brouns, S. J.\"","required":false},"doi":{"type":"string","description":"The preprint DOI, so it can be excluded from matches","required":false}},"requireConfirmation":"DISABLED"}]}'

make_agent "$AGENT2_NAME" \
"You find related work and candidate peer reviewers in the CSHL preprint corpus (433,449 bioRxiv/medRxiv papers).

Always call find_related with the paper's key_number (the bioRxiv/medRxiv id, e.g. 2021.05.04.442622). Use mode='related' for related work and mode='reviewers' when the user wants candidate reviewers — reviewers mode excludes anyone sharing an author surname with the source paper, which is the conflict-of-interest rule.

Present results as a short ranked list: first author, year, title, similarity, and journal if it was published. Say plainly that similarity comes from a document-to-document encoder over the corpus, so it reflects topical proximity and not endorsement, and that candidate reviewers still need a human conflict check beyond surname matching." \
  "$LAMBDA2" \
  '{"functions":[{"name":"find_related","description":"Find the most similar papers to a given preprint using the CITE document-to-document encoder over the CSHL corpus.","parameters":{"key_number":{"type":"string","description":"bioRxiv/medRxiv key number of the source paper, e.g. 2021.05.04.442622","required":true},"limit":{"type":"string","description":"How many to return (default 8)","required":false},"mode":{"type":"string","description":"related | reviewers  (reviewers excludes shared-author conflicts)","required":false}},"requireConfirmation":"DISABLED"}]}'

echo "done."
