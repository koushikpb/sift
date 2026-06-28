import { Pool, type PoolClient } from "pg";
import * as dotenv from "dotenv";
import { fileURLToPath } from "node:url";

// Load the repo-root .env for standalone (CLI / tsx) usage. When this module is
// bundled by a framework (e.g. Next.js webpack), `import.meta.url` is rewritten and
// the host has already populated process.env — so only attempt the file load when
// DATABASE_URL is absent, and never let a bundled context throw on path resolution.
if (!process.env.DATABASE_URL) {
  try {
    dotenv.config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });
  } catch {
    dotenv.config();
  }
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set (copy .env.example to .env)");
}

export const pool = new Pool({ connectionString });

/** Run `fn` with a pooled client, always releasing it. */
export async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}
