import { Pool, type PoolClient } from "pg";
import * as dotenv from "dotenv";
import { fileURLToPath } from "node:url";

dotenv.config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

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
