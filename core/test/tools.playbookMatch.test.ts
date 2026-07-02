import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { loadPlaybook } from "../src/eval/playbook.js";
import { matchPlaybookEntry, playbookForObjective } from "../src/agent/tools/playbookMatch.js";

const entries = loadPlaybook(fileURLToPath(new URL("../../evals/playbook/nda.yaml", import.meta.url)));

describe("matchPlaybookEntry", () => {
  it("matches a CUAD label directly on clause_type (case-insensitive)", () => {
    expect(matchPlaybookEntry("governing law", entries)?.playbook_id).toBe("governing_law");
  });
  it("matches via the synonyms map when the label differs from the playbook wording", () => {
    // "Confidential Information" has no direct playbook clause_type (that entry is
    // "Definition of Confidential Information"); it resolves ONLY through the synonym map.
    expect(matchPlaybookEntry("Confidential Information", entries)?.playbook_id).toBe("definition_scope");
  });
  it("returns null for a clause type with no playbook position", () => {
    expect(matchPlaybookEntry("Volume Restriction", entries)).toBeNull();
  });
});

describe("playbookForObjective", () => {
  it("resolves an explicit '(playbook requires X)' tag (missing items)", () => {
    const obj = 'Determine whether this NDA contains a clause addressing: "..." (playbook requires return_of_materials)';
    expect(playbookForObjective(obj, entries)?.playbook_id).toBe("return_of_materials");
  });
  it("resolves a ContractNLI hypothesis signature (deviated items)", () => {
    expect(playbookForObjective("Assess the hypothesis: Receiving Party shall destroy or return some Confidential Information upon the termination of Agreement.", entries)?.playbook_id).toBe("return_of_materials");
    expect(playbookForObjective("Assess the hypothesis: Receiving Party shall not reverse engineer any objects which embody Confidential Information.", entries)?.playbook_id).toBe("exclusions");
    expect(playbookForObjective("Assess the hypothesis: Agreement shall not grant Receiving Party any right to Confidential Information.", entries)?.playbook_id).toBe("definition_scope");
  });
  it("returns null when the objective concerns no playbook position", () => {
    expect(playbookForObjective("Assess the hypothesis: the sky is blue.", entries)).toBeNull();
  });
});
