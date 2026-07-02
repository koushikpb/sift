import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/** Sample MCP client: spawn the sift server, list tools, call retrieve_clause once. */
async function main(): Promise<void> {
  const transport = new StdioClientTransport({ command: "npx", args: ["tsx", "src/mcp/server.ts"] });
  const client = new Client({ name: "sift-sample-client", version: "0.1.0" });
  await client.connect(transport);

  const tools = await client.listTools();
  process.stdout.write("tools: " + tools.tools.map((t) => t.name).join(", ") + "\n");

  const docId = process.argv[2] ?? "cuad_limeenergyco-09-09-1999-ex-10-distributor-agreement";
  // Raise the per-call timeout above the SDK's 60s default: a cold retrieve_clause loads the
  // embedding model and makes a throttled NIM call, which can exceed 60s on first use.
  const res = await client.callTool(
    { name: "retrieve_clause", arguments: { objective: "Find the governing law clause", doc_id: docId } },
    undefined,
    { timeout: 180000 },
  );
  process.stdout.write("retrieve_clause -> " + JSON.stringify(res.content) + "\n");

  await client.close();
}

main().catch((e) => { process.stderr.write(String(e) + "\n"); process.exit(1); });
