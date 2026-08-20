# Shared names for the Bedrock KB experiment. Sourced by every script here.
# Everything is namespaced cshl-kb-* so it cannot be confused with the training
# lanes' resources in the same account.
export AWS_REGION="${AWS_REGION:-us-east-1}"
export ACCOUNT_ID="638175140432"
export KB_NAME="cshl-kb-slice"
export DS_NAME="cshl-kb-slice-ds"
export DOC_BUCKET="cshl-kb-corpus-${ACCOUNT_ID}"
export VEC_BUCKET="cshl-kb-vectors"
export VEC_INDEX="cshl-kb-slice-10k"
export KB_ROLE="cshl-kb-role"
export EMBED_MODEL="amazon.titan-embed-text-v2:0"
export EMBED_ARN="arn:aws:bedrock:${AWS_REGION}::foundation-model/${EMBED_MODEL}"
export GEN_MODEL="us.anthropic.claude-haiku-4-5-20251001-v1:0"   # same generator /chat defaults to
export AGENT_ROLE="cshl-kb-agent-role"
export AGENT1_NAME="cshl-pubstatus-clerk"
export AGENT2_NAME="cshl-related-work"
export LAMBDA1="cshl-kb-pubstatus"
export LAMBDA2="cshl-kb-relatedwork"
export STATE_DIR="$(git rev-parse --show-toplevel 2>/dev/null || pwd)/scripts/kb/.state"
mkdir -p "$STATE_DIR"
