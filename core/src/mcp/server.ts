import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { writeFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { buildTools, type BuildDeps } from "./tools.js";
import { retrieve as realRetrieve } from "../retrieve/retrieve.js";
import { makeGenerator } from "../generate/index.js";
import { defaultRunPredict } from "../agent/tools/classifyClause.js";
import { defaultDeviationJudge } from "../agent/tools/flagRisks.js";
import { defaultRedlineWriter } from "../agent/tools/draftRedline.js";

/** Build an MCP server exposing the six P4 tools over stdio. */
export function buildServer(deps: BuildDeps): McpServer {
  const server = new McpServer({ name: "sift-contract-review", version: "0.4.0" });
  for (const tool of buildTools(deps)) {
    server.registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: tool.inputShape },
      // args type is inferred from inputShape (ZodRawShape → Record<string,any>); explicit
      // ": unknown" annotation is omitted so TypeScript accepts the ToolCallback<ZodRawShape> constraint.
      async (args) => {
        const input = z.object(tool.inputShape).parse(args);
        const out = await tool.run(input);
        return { content: [{ type: "text" as const, text: JSON.stringify(out) }] };
      },
    );
  }
  return server;
}

async function main(): Promise<void> {
  const gen = makeGenerator();
  const judge = defaultDeviationJudge();
  const redline = defaultRedlineWriter();
  const server = buildServer({
    retrieve: realRetrieve,
    generate: gen.generate.bind(gen),
    runPredict: defaultRunPredict,
    judge: judge.judge,
    suggest: redline.suggest,
    writeFile: async (path, contents) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, contents); },
  });
  await server.connect(new StdioServerTransport());
  process.stderr.write("sift MCP server ready on stdio\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { process.stderr.write(String(e) + "\n"); process.exit(1); });
}
