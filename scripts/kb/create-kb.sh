#!/usr/bin/env bash
# create-kb.sh — stand up the managed Bedrock KB over the slice already in S3.
#
# Vector store is S3 VECTORS, deliberately. The console's quick-create path uses
# OpenSearch Serverless, which bills a ~2-OCU floor (~$11.50/day) whether or not
# anyone queries it — it would consume the entire experiment budget while idle.
# S3 Vectors is per-GB + per-query with no idle floor.
#
# Chunking is left at the managed default (FIXED_SIZE 300 tokens / 20% overlap),
# stated explicitly rather than omitted, because the point of the comparison is
# what the product does out of the box. Our side stores one vector per document,
# so the scorer DEDUPES chunk hits to document level before computing R@10.
set -euo pipefail
source "$(dirname "$0")/env.sh"

ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${KB_ROLE}"
VEC_ARN="arn:aws:s3vectors:${AWS_REGION}:${ACCOUNT_ID}:bucket/${VEC_BUCKET}"

KBID=$(aws bedrock-agent list-knowledge-bases --region "$AWS_REGION" \
        --query "knowledgeBaseSummaries[?name=='$KB_NAME'].knowledgeBaseId | [0]" --output text)
if [ "$KBID" = "None" ] || [ -z "$KBID" ]; then
  echo "creating knowledge base…"
  KBID=$(aws bedrock-agent create-knowledge-base --region "$AWS_REGION" \
    --name "$KB_NAME" \
    --description "CSHL 10k preprint slice — managed-RAG bake-off against our own stack" \
    --role-arn "$ROLE_ARN" \
    --knowledge-base-configuration "{\"type\":\"VECTOR\",\"vectorKnowledgeBaseConfiguration\":{\"embeddingModelArn\":\"$EMBED_ARN\",\"embeddingModelConfiguration\":{\"bedrockEmbeddingModelConfiguration\":{\"dimensions\":1024,\"embeddingDataType\":\"FLOAT32\"}}}}" \
    --storage-configuration "{\"type\":\"S3_VECTORS\",\"s3VectorsConfiguration\":{\"vectorBucketArn\":\"$VEC_ARN\",\"indexName\":\"$VEC_INDEX\"}}" \
    --query 'knowledgeBase.knowledgeBaseId' --output text)
fi
echo "KB: $KBID"; echo "$KBID" > "$STATE_DIR/kb_id"

DSID=$(aws bedrock-agent list-data-sources --region "$AWS_REGION" --knowledge-base-id "$KBID" \
        --query "dataSourceSummaries[?name=='$DS_NAME'].dataSourceId | [0]" --output text)
if [ "$DSID" = "None" ] || [ -z "$DSID" ]; then
  echo "creating data source…"
  DSID=$(aws bedrock-agent create-data-source --region "$AWS_REGION" --knowledge-base-id "$KBID" \
    --name "$DS_NAME" \
    --data-source-configuration "{\"type\":\"S3\",\"s3Configuration\":{\"bucketArn\":\"arn:aws:s3:::$DOC_BUCKET\",\"inclusionPrefixes\":[\"docs/\"]}}" \
    --vector-ingestion-configuration '{"chunkingConfiguration":{"chunkingStrategy":"FIXED_SIZE","fixedSizeChunkingConfiguration":{"maxTokens":300,"overlapPercentage":20}}}' \
    --query 'dataSource.dataSourceId' --output text)
fi
echo "DS: $DSID"; echo "$DSID" > "$STATE_DIR/ds_id"

JOB=$(aws bedrock-agent start-ingestion-job --region "$AWS_REGION" \
  --knowledge-base-id "$KBID" --data-source-id "$DSID" \
  --query 'ingestionJob.ingestionJobId' --output text)
echo "ingestion job: $JOB"; echo "$JOB" > "$STATE_DIR/job_id"
