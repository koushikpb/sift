# sift MCP server — quickstart

The sift contract-review toolset is exposed over the Model Context Protocol (stdio).

## Tools
- `retrieve_clause` (read) — Layer 1 RAG → grounded, cited answer (or refusal).
- `extract_fields` (read) — extract a named field (e.g. Governing Law, Term) with a citation.
- `classify_clause` (read) — P3 LoRA classifier → CUAD clause type.
- `flag_risks` (read) — match clause to the NDA playbook + judge deviation.
- `draft_redline` (read) — propose playbook-compliant replacement text.
- `export_memo` (**write**) — render the memo; writes to disk ONLY with `confirm: true` (human-in-the-loop).

## Run the server
```
make db-up                 # retrieve_clause needs Postgres
set -a; . ./.env; set +a   # LLM_API_KEY etc.
make mcp-serve             # cd core && npm run mcp
```

## Sample client call
```
cd core && npx tsx src/mcp/sampleClient.ts <doc_id>
```
Expected: prints the registered tool names, then a grounded `retrieve_clause` result. `export_memo`
called without `confirm: true` returns a preview (`written: false`) — nothing is persisted until a
human confirms.

## Register with Claude Desktop / any MCP client
Command: `npx`, args: `["tsx", "<repo>/core/src/mcp/server.ts"]`, with `.env` in the environment.
