#!/bin/bash
# Runs when LocalStack is ready. The app also creates the queues on boot (idempotent).
set -euo pipefail
awslocal sqs create-queue --queue-name wager-transactions-dlq.fifo --attributes FifoQueue=true
DLQ_ARN=$(awslocal sqs get-queue-attributes \
  --queue-url http://localhost:4566/000000000000/wager-transactions-dlq.fifo \
  --attribute-names QueueArn --query Attributes.QueueArn --output text)
awslocal sqs create-queue --queue-name wager-transactions.fifo --attributes "{
  \"FifoQueue\": \"true\",
  \"VisibilityTimeout\": \"30\",
  \"RedrivePolicy\": \"{\\\"deadLetterTargetArn\\\":\\\"${DLQ_ARN}\\\",\\\"maxReceiveCount\\\":\\\"5\\\"}\"
}"
awslocal sqs create-queue --queue-name wagering-events
echo "queues ready"