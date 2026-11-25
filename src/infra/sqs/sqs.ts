import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { config } from "../../config";

export function createSqsClient(): SQSClient {
  return new SQSClient({
    endpoint: config.aws.endpoint,
    region: config.aws.region,
    // LocalStack accepts any credentials; real AWS would use the default provider chain.
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test",
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
    },
  });
}

export async function queueUrl(sqs: SQSClient, name: string): Promise<string> {
  const out = await sqs.send(new GetQueueUrlCommand({ QueueName: name }));
  return out.QueueUrl!;
}

/**
 * Creates the queues if they do not exist (idempotent).
 * The main FIFO queue moves a message to the DLQ after maxReceiveCount receives.
 */
export async function ensureQueues(
  sqs: SQSClient,
  options = {
    main: config.queues.transactions,
    events: config.queues.events,
    maxReceiveCount: config.sqs.maxReceiveCount,
    visibilityTimeoutSeconds: config.sqs.visibilityTimeoutSeconds,
  },
): Promise<{ main: string; dlq: string; events: string }> {
  const names = options;
  const dlqName = names.main.replace(/\.fifo$/, "-dlq.fifo");
  const dlq = await sqs.send(new CreateQueueCommand({ QueueName: dlqName, Attributes: { FifoQueue: "true" } }));
  const dlqAttrs = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl: dlq.QueueUrl, AttributeNames: ["QueueArn"] }),
  );
  const main = await sqs.send(
    new CreateQueueCommand({
      QueueName: names.main,
      Attributes: {
        FifoQueue: "true",
        VisibilityTimeout: String(options.visibilityTimeoutSeconds),
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: dlqAttrs.Attributes!.QueueArn,
          maxReceiveCount: String(options.maxReceiveCount),
        }),
      },
    }),
  );
  const events = await sqs.send(new CreateQueueCommand({ QueueName: names.events }));
  return { main: main.QueueUrl!, dlq: dlq.QueueUrl!, events: events.QueueUrl! };
}