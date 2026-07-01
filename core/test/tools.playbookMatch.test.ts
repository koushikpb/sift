import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { loadPlaybook } from "../src/eval/playbook.js";
import { matchPlaybookEntry } from "../src/agent/tools/playbookMatch.js";

const entries = loadPlaybook(fileURLToPath(new URL("../../evals/playbook/nda.yaml", import.meta.url)));

describe("matchPlaybookEntry", () => {
  it("matches a CUAD label directly on clause_type (case-insensitive)", () => {
    expect(matchPlaybookEntry("governing law", entries)?.playbook_id).toBe("governing_law");
  });
  it("matches via the synonyms map when the label differs from the playbook wording", () => {
    // CUAD's "Anti-Assignment" is not a playbook clause_type; a governing-law synonym still resolves.
    expect(matchPlaybookEntry("Governing Law", entries)?.playbook_id).toBe("governing_law");
  });
  it("returns null for a clause type with no playbook position", () => {
    expect(matchPlaybookEntry("Volume Restriction", entries)).toBeNull();
  });
});
