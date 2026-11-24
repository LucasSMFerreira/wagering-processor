import type { MikroORM } from "@mikro-orm/postgresql";
import { createOrm } from "../../src/infra/db/orm";

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://wagering:wagering@localhost:5432/wagering_test";

/** Creates the test database if needed and applies the migrations from zero. */
export async function setupDatabase(): Promise<MikroORM> {
  const admin = await createOrm(TEST_DATABASE_URL.replace(/\/[^/]+$/, "/postgres"));
  const name = TEST_DATABASE_URL.split("/").pop()!;
  const exists = await admin.em.getConnection().execute("select 1 from pg_database where datname = ?", [name]);
  if (exists.length === 0) await admin.em.getConnection().execute(`create database "${name}"`);
  await admin.close();

  const orm = await createOrm(TEST_DATABASE_URL);
  await orm.em.getConnection().execute("drop schema public cascade; create schema public;");
  await orm.getMigrator().up();
  return orm;
}

export async function resetDatabase(orm: MikroORM): Promise<void> {
  await orm.em
    .getConnection()
    .execute("truncate ledger_entries, outbox_messages, inbox_messages, wager_transactions, wallets cascade");
}

export async function sql<T = Record<string, unknown>>(orm: MikroORM, query: string, params: unknown[] = []) {
  return (await orm.em.getConnection().execute(query, params)) as T[];
}

/** wallet.balance == balance rebuilt from the ledger, for every wallet. */
export async function assertLedgerInvariant(orm: MikroORM): Promise<void> {
  const broken = await sql(
    orm,
    `select w.id, w.balance_amount::text as stored,
            coalesce(sum(case l.direction when 'CREDIT' then l.amount else -l.amount end), 0)::numeric(20,2)::text as calculated
       from wallets w left join ledger_entries l on l.wallet_id = w.id
      group by w.id having w.balance_amount <> coalesce(sum(case l.direction when 'CREDIT' then l.amount else -l.amount end), 0)`,
  );
  if (broken.length > 0) throw new Error(`ledger invariant broken: ${JSON.stringify(broken)}`);
}