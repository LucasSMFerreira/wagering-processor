import type { IntegrationEvent } from "./events";

export interface InboxMessageState {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt?: Date | undefined;
}

/** A message the consumer has already seen. Unique by (consumerName, messageId). */
export class InboxMessage {
  private constructor(
    readonly messageId: string,
    readonly consumerName: string,
    readonly payloadHash: string,
    readonly receivedAt: Date,
    private _processedAt?: Date,
  ) {}

  static receive(props: Omit<InboxMessageState, "processedAt">): InboxMessage {
    return new InboxMessage(props.messageId, props.consumerName, props.payloadHash, props.receivedAt);
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(state.messageId, state.consumerName, state.payloadHash, state.receivedAt, state.processedAt);
  }

  get processedAt() {
    return this._processedAt;
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  markProcessed(at: Date): void {
    this._processedAt ??= at;
  }
}

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date | undefined;
  publishedAt?: Date | undefined;
}

export const OUTBOX_BASE_DELAY_MS = 1_000;
export const OUTBOX_MAX_DELAY_MS = 5 * 60_000;

/** An event waiting to leave the service. Written in the same SQL transaction as the change. */
export class OutboxMessage {
  private constructor(
    readonly id: string,
    readonly aggregateId: string,
    readonly eventType: string,
    readonly payload: Readonly<Record<string, unknown>>,
    readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
  ) {}

  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      event.toJSON() as unknown as Record<string, unknown>,
      event.occurredAt,
      0,
      event.occurredAt,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
    );
  }

  get attempts() {
    return this._attempts;
  }
  get nextAttemptAt() {
    return this._nextAttemptAt;
  }
  get publishedAt() {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && (this._nextAttemptAt === undefined || this._nextAttemptAt <= now);
  }

  markPublished(at: Date): void {
    this._publishedAt ??= at;
  }

  /** Exponential backoff: 1s, 2s, 4s... capped at 5 min. */
  scheduleRetry(now: Date): void {
    this._attempts += 1;
    const delay = Math.min(OUTBOX_BASE_DELAY_MS * 2 ** (this._attempts - 1), OUTBOX_MAX_DELAY_MS);
    this._nextAttemptAt = new Date(now.getTime() + delay);
  }
}