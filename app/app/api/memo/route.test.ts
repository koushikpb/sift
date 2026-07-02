import { describe, it, expect, vi, afterEach } from "vitest";
import { POST } from "./route";

function req(body: unknown): Request {
  return new Request("http://localhost/api/memo", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const baseBody = {
  doc_id: "contractnli_4",
  objective: "Term / Duration of Confidentiality",
  flags: [
    {
      playbook_id: "confidentiality_term",
      clause_type: "Term / Duration of Confidentiality",
      severity: "high" as const,
      deviation: true,
      rationale: "Perpetual term exceeds the 3-5 year standard position.",
      citation: { doc_id: "contractnli_4", char_start: 100, char_end: 153, quote: "This Agreement shall remain in effect in perpetuity." },
    },
  ],
  redlines: [
    {
      playbook_id: "confidentiality_term",
      original: { doc_id: "contractnli_4", char_start: 100, char_end: 153, quote: "This Agreement shall remain in effect in perpetuity." },
      suggested_text: "This Agreement shall remain in effect for five (5) years.",
      rationale: "Brings the term within the playbook's standard 3-5 year range.",
    },
  ],
};

describe("POST /api/memo — HITL-gated export", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("without confirm, returns written:false and a preview only — no memo materializes", async () => {
    const res = await POST(req(baseBody));
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(json.written).toBe(false);
    expect(typeof json.preview).toBe("string");
    expect(json.preview).toContain("# Contract Review Memo");
    expect(json.preview).toContain("confidentiality_term");
    expect(json.preview).toContain("five (5) years");
    // The confirm-gated field must not leak on the preview path.
    expect(json.markdown).toBeUndefined();
  });

  it("confirm:false behaves identically to confirm omitted (still a preview, not a write)", async () => {
    const res = await POST(req({ ...baseBody, confirm: false }));
    const json = await res.json();
    expect(json.written).toBe(false);
    expect(typeof json.preview).toBe("string");
  });

  it("with confirm:true, returns the rendered memo markdown (renderMemoMarkdown output)", async () => {
    const res = await POST(req({ ...baseBody, confirm: true }));
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(json.written).toBe(true);
    expect(typeof json.markdown).toBe("string");
    expect(json.markdown).toContain("# Contract Review Memo");
    expect(json.markdown).toContain("confidentiality_term");
    expect(json.markdown).toContain("five (5) years");
    expect(json.preview).toBeUndefined();
  });

  it("renders identical markdown content for preview and confirmed variants of the same input", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-01T00:00:00.000Z"));

    const previewRes = await POST(req(baseBody));
    const preview = (await previewRes.json()).preview as string;

    const confirmRes = await POST(req({ ...baseBody, confirm: true }));
    const markdown = (await confirmRes.json()).markdown as string;

    expect(markdown).toBe(preview);
  });

  it("succeeds on both paths purely off the injected no-op writer — no real persistence dependency", async () => {
    // route.ts injects `writeFile: async () => {}` into makeExportMemoTool (see its module doc):
    // the confirmed path below only succeeds because that no-op resolves, not because anything was
    // actually written anywhere. (Static check: `grep -L "node:fs" app/app/api/memo/route.ts
    // core/src/agent/tools/exportMemo.ts` — neither file imports fs; confirmed during self-review.)
    const previewRes = await POST(req(baseBody));
    const confirmRes = await POST(req({ ...baseBody, confirm: true }));
    expect(previewRes.status).toBe(200);
    expect(confirmRes.status).toBe(200);
  });

  it("rejects a request missing required fields with a generic 400 (no stack/zod leakage)", async () => {
    const res = await POST(req({ objective: "Term / Duration of Confidentiality" }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(typeof json.error).toBe("string");
    expect(json.error.toLowerCase()).not.toContain("zod");
    expect(json.error).not.toContain("stack");
  });

  it("rejects malformed JSON with a generic 400", async () => {
    const res = await POST(
      new Request("http://localhost/api/memo", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(typeof json.error).toBe("string");
  });

  it("cannot be tricked into a write via a body field other than the literal boolean confirm:true", async () => {
    const res = await POST(req({ ...baseBody, confirm: "true" }));
    // confirm must be a real boolean per the Zod schema — a string "true" is a validation error,
    // not a silently-coerced confirmation.
    expect(res.status).toBe(400);
  });
});
