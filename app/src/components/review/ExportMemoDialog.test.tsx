import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ExportMemoDialog } from "./ExportMemoDialog";
import type { ExportMemoDialogProps } from "./ExportMemoDialog";

const baseProps: ExportMemoDialogProps = {
  docId: "contractnli_4",
  objective: "Term / Duration of Confidentiality",
  flags: [
    {
      playbook_id: "confidentiality_term",
      clause_type: "Term / Duration of Confidentiality",
      severity: "high",
      deviation: true,
      rationale: "Perpetual term exceeds the 3-5 year standard position.",
      citation: null,
    },
  ],
  redlines: [],
};

const PREVIEW_MARKDOWN = "# Contract Review Memo\n\n_preview content_\n";
const CONFIRMED_MARKDOWN = "# Contract Review Memo\n\n_confirmed content_\n";

function jsonResponse(body: unknown) {
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
}

/** jsdom's Blob implementation has no .text()/.arrayBuffer() and isn't recognized by the Node
    Response body reader, so FileReader (which jsdom does implement fully) is the reliable path. */
function readBlobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

function makeFetchMock() {
  return vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(init.body as string) as { confirm?: boolean }) : {};
    if (body.confirm === true) {
      return jsonResponse({ written: true, markdown: CONFIRMED_MARKDOWN });
    }
    return jsonResponse({ written: false, preview: PREVIEW_MARKDOWN });
  });
}

describe("ExportMemoDialog — HITL gate made visible in the UI", () => {
  let fetchMock: ReturnType<typeof makeFetchMock>;
  let createObjectURLMock: ReturnType<typeof vi.fn<[Blob], string>>;
  let revokeObjectURLMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = makeFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    createObjectURLMock = vi.fn((_blob: Blob) => "blob:mock-url");
    revokeObjectURLMock = vi.fn();
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: createObjectURLMock, revokeObjectURL: revokeObjectURLMock }));

    // jsdom has no real navigation target for a "blob:" href — silence its "Not implemented:
    // navigation" console noise by preventing the actual click-triggered navigation. The
    // assertions below verify the Blob's *content* and the createObjectURL/revokeObjectURL calls
    // directly, which is what actually proves a download was (or wasn't) triggered.
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("opening the dialog fetches a preview only — no confirm sent, nothing downloaded yet", async () => {
    render(<ExportMemoDialog {...baseProps} />);

    fireEvent.click(screen.getByRole("button", { name: "Export memo" }));

    await waitFor(() => expect(screen.getByText(/preview content/)).toBeInTheDocument());

    // Exactly one fetch so far, and it must not have sent confirm:true.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [RequestInfo, RequestInit];
    const sentBody = JSON.parse(init.body as string) as { confirm?: boolean };
    expect(sentBody.confirm).not.toBe(true);

    // The HITL invariant, made concrete: viewing the preview must not trigger a download.
    expect(createObjectURLMock).not.toHaveBeenCalled();
  });

  it("clicking Confirm & download is the only path that sends confirm:true, and only then downloads", async () => {
    render(<ExportMemoDialog {...baseProps} />);

    fireEvent.click(screen.getByRole("button", { name: "Export memo" }));
    await waitFor(() => expect(screen.getByText(/preview content/)).toBeInTheDocument());

    expect(createObjectURLMock).not.toHaveBeenCalled(); // still nothing downloaded pre-confirm

    fireEvent.click(screen.getByRole("button", { name: "Confirm & download" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const [, confirmInit] = fetchMock.mock.calls[1] as [RequestInfo, RequestInit];
    const confirmBody = JSON.parse(confirmInit.body as string) as { confirm?: boolean };
    expect(confirmBody.confirm).toBe(true);

    await waitFor(() => expect(createObjectURLMock).toHaveBeenCalledTimes(1));
    const [downloadedBlob] = createObjectURLMock.mock.calls[0] as [Blob];
    expect(await readBlobText(downloadedBlob)).toBe(CONFIRMED_MARKDOWN);
    expect(revokeObjectURLMock).toHaveBeenCalledWith("blob:mock-url");

    await waitFor(() => expect(screen.getByRole("button", { name: "Downloaded" })).toBeInTheDocument());
  });
});
