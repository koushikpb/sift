import { describe, it, expect, vi, afterEach } from "vitest";
import { POST } from "./route";
import { resetRateLimitersForTests } from "../../../src/lib/rateLimit";

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
    // Each request in this file shares one client key (no x-forwarded-for header on these test
    // Requests, so getClientKey falls back to the local-dev constant) and hits the same "memo"
    // rate-limit bucket. Reset between tests so this suite's request count is decoupled from
    // RATE_LIMIT_RPM's numeric value.
    resetRateLimitersForTests();
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

  it("enforces the per-IP rate limit before body validation: past RATE_LIMIT_RPM -> 429 with Retry-After", async () => {
    process.env.RATE_LIMIT_RPM = "2";
    const first = await POST(req(baseBody));
    const second = await POST(req(baseBody));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const third = await POST(req(baseBody));
    expect(third.status).toBe(429);
    expect(third.headers.get("retry-after")).toBeTruthy();
    const json = await third.json();
    expect(typeof json.error).toBe("string");
    delete process.env.RATE_LIMIT_RPM;
  });

  it("rejects a flags array beyond the max length cap (M7-4)", async () => {
    const manyFlags = Array.from({ length: 51 }, (_, i) => ({ ...baseBody.flags[0], playbook_id: `p${i}` }));
    const res = await POST(req({ ...baseBody, flags: manyFlags }));
    expect(res.status).toBe(400);
  });

  it("rejects a redlines array beyond the max length cap (M7-4)", async () => {
    const manyRedlines = Array.from({ length: 51 }, (_, i) => ({ ...baseBody.redlines[0], playbook_id: `p${i}` }));
    const res = await POST(req({ ...baseBody, redlines: manyRedlines }));
    expect(res.status).toBe(400);
  });

  it("rejects an oversized rationale string in a flag (M7-4)", async () => {
    const res = await POST(
      req({ ...baseBody, flags: [{ ...baseBody.flags[0], rationale: "x".repeat(2001) }] }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects an oversized suggested_text in a redline (M7-4)", async () => {
    const res = await POST(
      req({ ...baseBody, redlines: [{ ...baseBody.redlines[0], suggested_text: "x".repeat(5001) }] }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects an objective over the shared length cap (M7-4)", async () => {
    const res = await POST(req({ ...baseBody, objective: "x".repeat(501) }));
    expect(res.status).toBe(400);
  });

  it("rejects an oversized quote inside a flag's citation span (nested bound, M7-4 fix round)", async () => {
    const res = await POST(
      req({
        ...baseBody,
        flags: [{ ...baseBody.flags[0], citation: { ...baseBody.flags[0].citation, quote: "x".repeat(20_001) } }],
      }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects an oversized quote inside a redline's original span (nested bound, M7-4 fix round)", async () => {
    const res = await POST(
      req({
        ...baseBody,
        redlines: [
          { ...baseBody.redlines[0], original: { ...baseBody.redlines[0].original, quote: "x".repeat(20_001) } },
        ],
      }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects citation offsets above the sanity ceiling and non-integer/negative offsets", async () => {
    const base = baseBody.flags[0].citation;
    for (const bad of [
      { char_start: 10_000_001 }, // above ceiling
      { char_end: 10_000_001 },
      { char_start: -1 }, // nonnegative (inherited from core SpanSchema, must survive the extend)
      { char_start: 1.5 }, // int (inherited)
    ]) {
      const res = await POST(
        req({ ...baseBody, flags: [{ ...baseBody.flags[0], citation: { ...base, ...bad } }] }),
      );
      expect(res.status).toBe(400);
    }
  });

  it("rejects an oversized playbook_id / clause_type identifier", async () => {
    const longId = "x".repeat(201);
    const viaFlag = await POST(req({ ...baseBody, flags: [{ ...baseBody.flags[0], playbook_id: longId }] }));
    const viaClauseType = await POST(req({ ...baseBody, flags: [{ ...baseBody.flags[0], clause_type: longId }] }));
    const viaRedline = await POST(
      req({ ...baseBody, redlines: [{ ...baseBody.redlines[0], playbook_id: longId }] }),
    );
    expect(viaFlag.status).toBe(400);
    expect(viaClauseType.status).toBe(400);
    expect(viaRedline.status).toBe(400);
  });

  it("still accepts a null flag citation (missing-required-clause finding) with the bounded span in place", async () => {
    const res = await POST(req({ ...baseBody, flags: [{ ...baseBody.flags[0], citation: null }] }));
    expect(res.status).toBe(200);
  });
});
