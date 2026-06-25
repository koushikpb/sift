import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { withClient } from "./client.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations", import.meta.url));

export async function migrate(): Promise<string[]> {
  const applied: string[] = [];
  await withClient(async (c) => {
    await c.query(
      "CREATE TABLE IF NOT EXISTS _migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
    for (const name of files) {
      const done = await c.query("SELECT 1 FROM _migrations WHERE name = $1", [name]);
      if (done.rowCount) continue;
      const sql = readFileSync(`${MIGRATIONS_DIR}/${name}`, "utf-8");
      await c.query("BEGIN");
      try {
        await c.query(sql);
        await c.query("INSERT INTO _migrations(name) VALUES ($1)", [name]);
        await c.query("COMMIT");
        applied.push(name);
      } catch (e) {
        await c.query("ROLLBACK");
        throw e;
      }
    }
  });
  return applied;
}

// Allow `tsx src/db/migrate.ts` as a CLI (robust under tsx's relative argv[1]).
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  migrate().then((a) => {
    console.log(a.length ? `applied: ${a.join(", ")}` : "no pending migrations");
    process.exit(0);
  });
}
