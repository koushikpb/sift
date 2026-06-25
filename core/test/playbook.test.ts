import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { loadPlaybook, playbookIds } from "../src/eval/playbook.js";

const path = fileURLToPath(new URL("../../evals/playbook/nda.yaml", import.meta.url));

describe("nda playbook", () => {
  it("loads and validates every entry", () => {
    const entries = loadPlaybook(path);
    expect(entries.length).toBeGreaterThanOrEqual(7);
    for (const e of entries) {
      expect(e.red_flags.length).toBeGreaterThan(0);
      expect(["low", "medium", "high"]).toContain(e.severity);
    }
  });

  it("exposes unique playbook ids including the key NDA positions", () => {
    const ids = playbookIds(loadPlaybook(path));
    expect(ids.has("confidentiality_term")).toBe(true);
    expect(ids.has("exclusions")).toBe(true);
    expect(ids.size).toBe(loadPlaybook(path).length); // ids are unique
  });
});
