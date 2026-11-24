import { Migration } from "@mikro-orm/migrations";

/**
 * The guarantees live here, not only in TypeScript:
 * uniqueness, non-negative balance, immutable ledger, one reversal per reference,
 * and the wallet balance always equal to the last ledger entry.
 */
export class Migration20261124000001_schema extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table wallets (
        id uuid primary key,
        player_id text not null,
        currency char(3) not null,
        balance_amount numeric(20, 2) not null check (balance_amount >= 0),
        version integer not null check (version >= 1),
        created_at timestamptz not null,
        updated_at timestamptz not null,
        constraint wallets_player_currency_unique unique (player_id, currency)
      );`);

    this.addSql(`
      create table wager_transactions (
        id uuid primary key,
        provider_id text not null,
        external_transaction_id text not null,
        idempotency_key text not null,
        payload_hash char(64) not null,
        wallet_id uuid not null references wallets (id) deferrable initially deferred,
        player_id text not null,
        round_id text not null,
        game_id text not null,
        kind text not null check (kind in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        amount numeric(20, 2) not null check (amount >= 0),
        currency char(3) not null,
        reference_external_transaction_id text,
        reference_transaction_id uuid references wager_transactions (id) deferrable initially deferred,
        status text not null check (status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        failure_code text,
        balance_after_amount numeric(20, 2),
        processed_at timestamptz,
        reference_attempts integer not null default 0,
        next_reference_check_at timestamptz,
        created_at timestamptz not null,
        constraint wager_tx_idempotency_key_unique unique (idempotency_key),
        constraint wager_tx_provider_external_unique unique (provider_id, external_transaction_id),
        constraint wager_tx_reversal_needs_reference
          check (kind not in ('REFUND', 'ROLLBACK') or reference_external_transaction_id is not null),
        constraint wager_tx_rejection_has_code
          check (status not in ('REJECTED', 'FAILED') or failure_code is not null),
        constraint wager_tx_pending_reference_has_schedule
          check ((status = 'PENDING_REFERENCE') = (next_reference_check_at is not null))
      );`);

    // A reference is reverted at most once, whatever the kind of the reversal.
    this.addSql(`
      create unique index wager_tx_one_reversal_per_reference
        on wager_transactions (reference_transaction_id)
        where status = 'PROCESSED' and kind in ('REFUND', 'ROLLBACK');`);
    this.addSql(`
      create index wager_tx_pending_reference_due
        on wager_transactions (next_reference_check_at)
        where status = 'PENDING_REFERENCE';`);

    // Terminal transactions never change again.
    this.addSql(`
      create function wager_tx_forbid_terminal_change() returns trigger as $$
      begin
        if old.status in ('PROCESSED', 'REJECTED', 'FAILED') then
          raise exception 'transaction % is % and cannot change', old.id, old.status
            using errcode = 'check_violation';
        end if;
        return new;
      end $$ language plpgsql;`);
    this.addSql(`
      create trigger wager_tx_terminal_is_final
        before update or delete on wager_transactions
        for each row execute function wager_tx_forbid_terminal_change();`);

    this.addSql(`
      create table ledger_entries (
        seq bigserial unique,
        id uuid primary key,
        wallet_id uuid not null references wallets (id) deferrable initially deferred,
        transaction_id uuid not null references wager_transactions (id) deferrable initially deferred,
        direction text not null check (direction in ('DEBIT', 'CREDIT')),
        amount numeric(20, 2) not null check (amount > 0),
        currency char(3) not null,
        balance_before numeric(20, 2) not null check (balance_before >= 0),
        balance_after numeric(20, 2) not null check (balance_after >= 0),
        created_at timestamptz not null,
        constraint ledger_one_entry_per_transaction unique (transaction_id, wallet_id),
        constraint ledger_entry_balances check (
          balance_after = balance_before + case direction when 'CREDIT' then amount else -amount end
        )
      );`);
    this.addSql(`create index ledger_entries_wallet_seq on ledger_entries (wallet_id, seq);`);

    // Append-only: no update, no delete.
    this.addSql(`
      create function ledger_forbid_change() returns trigger as $$
      begin
        raise exception 'ledger entries are immutable' using errcode = 'check_violation';
      end $$ language plpgsql;`);
    this.addSql(`
      create trigger ledger_entries_append_only
        before update or delete on ledger_entries
        for each row execute function ledger_forbid_change();`);

    // Each entry continues where the previous one stopped.
    this.addSql(`
      create function ledger_check_chain() returns trigger as $$
      declare previous numeric(20, 2);
      begin
        select balance_after into previous from ledger_entries
          where wallet_id = new.wallet_id order by seq desc limit 1;
        if coalesce(previous, 0) <> new.balance_before then
          raise exception 'ledger chain broken for wallet %: expected %, got %',
            new.wallet_id, coalesce(previous, 0), new.balance_before using errcode = 'check_violation';
        end if;
        return new;
      end $$ language plpgsql;`);
    this.addSql(`
      create trigger ledger_entries_chain
        before insert on ledger_entries
        for each row execute function ledger_check_chain();`);

    // At commit time, the wallet balance must equal its last ledger entry.
    this.addSql(`
      create function wallet_check_matches_ledger() returns trigger as $$
      declare last_after numeric(20, 2);
      begin
        select balance_after into last_after from ledger_entries
          where wallet_id = new.id order by seq desc limit 1;
        if coalesce(last_after, 0) <> new.balance_amount then
          raise exception 'wallet % balance % does not match ledger %',
            new.id, new.balance_amount, coalesce(last_after, 0) using errcode = 'check_violation';
        end if;
        return null;
      end $$ language plpgsql;`);
    this.addSql(`
      create constraint trigger wallets_match_ledger
        after insert or update of balance_amount on wallets
        deferrable initially deferred
        for each row execute function wallet_check_matches_ledger();`);

    this.addSql(`
      create table inbox_messages (
        consumer_name text not null,
        message_id text not null,
        payload_hash char(64) not null,
        received_at timestamptz not null,
        processed_at timestamptz,
        primary key (consumer_name, message_id)
      );`);

    this.addSql(`
      create table outbox_messages (
        seq bigserial unique,
        id uuid primary key,
        aggregate_id text not null,
        event_type text not null,
        payload jsonb not null,
        occurred_at timestamptz not null,
        attempts integer not null default 0,
        next_attempt_at timestamptz not null,
        locked_until timestamptz,
        published_at timestamptz
      );`);
    this.addSql(`
      create index outbox_messages_pending
        on outbox_messages (next_attempt_at)
        where published_at is null;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists outbox_messages;`);
    this.addSql(`drop table if exists inbox_messages;`);
    this.addSql(`drop table if exists ledger_entries;`);
    this.addSql(`drop table if exists wager_transactions;`);
    this.addSql(`drop table if exists wallets;`);
    this.addSql(`drop function if exists wallet_check_matches_ledger();`);
    this.addSql(`drop function if exists ledger_check_chain();`);
    this.addSql(`drop function if exists ledger_forbid_change();`);
    this.addSql(`drop function if exists wager_tx_forbid_terminal_change();`);
  }
}