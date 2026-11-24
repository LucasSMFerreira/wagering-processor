import { Migrator } from "@mikro-orm/migrations";
import { MikroORM, type Options, PostgreSqlDriver } from "@mikro-orm/postgresql";
import { config } from "../../config";
import { Migration20261124000001_schema } from "./migrations/Migration20261124000001_schema";
import { schemas } from "./records";

export function ormOptions(databaseUrl = config.databaseUrl): Options {
  return {
    driver: PostgreSqlDriver,
    clientUrl: databaseUrl,
    entities: schemas,
    pool: { min: 1, max: config.dbPoolMax },
    extensions: [Migrator],
    // Migrations are listed explicitly: no file discovery, works the same under Bun.
    migrations: {
      migrationsList: [{ name: "Migration20261124000001_schema", class: Migration20261124000001_schema }],
      transactional: true,
      allOrNothing: true,
      silent: true,
    },
    // Every request forks its own EntityManager; the global one must never be used.
    allowGlobalContext: false,
    debug: false,
  };
}

export function createOrm(databaseUrl?: string): Promise<MikroORM> {
  return MikroORM.init(ormOptions(databaseUrl));
}