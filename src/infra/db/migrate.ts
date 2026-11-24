import { createOrm } from "./orm";

const direction = process.argv[2] ?? "up";
const orm = await createOrm();
const migrator = orm.getMigrator();

if (direction === "down") {
  const done = await migrator.down();
  console.log(`reverted: ${done.map((m) => m.name).join(", ") || "nothing"}`);
} else {
  const done = await migrator.up();
  console.log(`applied: ${done.map((m) => m.name).join(", ") || "nothing"}`);
}
await orm.close();