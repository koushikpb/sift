import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { migrate } from "../src/db/migrate.js";
import { withClient, pool } from "../src/db/client.js";

describe("schema + pgvector", () => {
  beforeAll(async () => { await migrate(); });
  afterAll(async () => { await pool.end(); });

  it("creates the core tables", async () => {
    const names = await withClient(async (c) =>
      (await c.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema='public'",
      )).rows.map((r) => r.table_name),
    );
    expect(names).toEqual(expect.arrayContaining(["documents", "clauses", "embeddings"]));
  });

  it("orders by cosine distance (pgvector works)", async () => {
    const nearest = await withClient(async (c) => {
      await c.query("BEGIN");
      try {
        await c.query("CREATE TEMP TABLE v_smoke (id int, e vector(3)) ON COMMIT DROP");
        await c.query("INSERT INTO v_smoke VALUES (1,'[1,0,0]'), (2,'[0,1,0]'), (3,'[0.9,0.1,0]')");
        const r = await c.query("SELECT id FROM v_smoke ORDER BY e <=> '[1,0,0]' LIMIT 1");
        await c.query("COMMIT");
        return r.rows[0].id;
      } catch (e) {
        await c.query("ROLLBACK");
        throw e;
      }
    });
    expect(nearest).toBe(1);
  });
});
