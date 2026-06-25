import { describe, it, expect, afterAll } from "vitest";
import { withClient, pool } from "../src/db/client.js";

describe("db connection", () => {
  it("runs SELECT 1", async () => {
    const value = await withClient(async (c) => (await c.query("SELECT 1 AS v")).rows[0].v);
    expect(value).toBe(1);
  });
});

afterAll(async () => {
  await pool.end();
});
