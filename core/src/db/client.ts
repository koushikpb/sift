import { Pool, type PoolClient } from "pg";
import * as dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Load the repo-root .env for standalone (CLI / tsx) usage. When this module is
// bundled by a framework (e.g. Next.js webpack), the host has already populated
// process.env — so only attempt the file load when DATABASE_URL is absent, and never
// let a bundled context throw on path resolution. Must NOT use the
// `new URL("<literal>", import.meta.url)` form: webpack resolves that literal as a
// build-time asset, and .env is gitignored — absent from CI/deploy clones, failing
// the build ("Module not found: Can't resolve '../../../.env'").
if (!process.env.DATABASE_URL) {
  try {
    dotenv.config({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env") });
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
