import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Bridge the repo-root .env into the Next server process: in this monorepo secrets
// live at the root, not in app/. Done here (next.config runs in a real Node context
// where import.meta.url resolves) with a tiny parser so app needs no extra dependency.
// @sift/core's db client / generator then read DATABASE_URL / LLM_* from process.env
// instead of resolving a path inside the webpack bundle (which breaks there).
try {
  const envPath = fileURLToPath(new URL("../.env", import.meta.url));
  for (const raw of readFileSync(envPath, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).replace(/^export\s+/, "").trim();
    if (!key || key in process.env) continue; // real env vars win
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
  }
} catch {
  // No root .env (e.g. CI injects env directly) — rely on ambient process.env.
}

// NOTE: do NOT try to default PLAYBOOK_PATH here with a process.env assignment. It works under
// `next dev`/`next start` but never reaches the deployed Vercel function: the build serializes
// the *resolved config* into .next/required-server-files.json with `env: {}` (an imperative
// process.env write at config-load time is a side effect, not config), and Vercel's launcher
// instantiates the server from that JSON without re-running this file. @sift/core/agent instead
// resolves the playbook with cwd-relative probes at request time (see resolvePlaybookPath in
// core/src/agent/index.ts), which works in the function because outputFileTracingIncludes below
// ships the YAML preserving the repo-relative layout. PLAYBOOK_PATH stays a manual override.

/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@sift/core"],
  // Keep Node-only deps out of the client/edge bundle.
  // Next 15+ option (replaces experimental.serverComponentsExternalPackages).
  serverExternalPackages: ["@huggingface/transformers", "pg"],
  // core/src/agent/index.ts (@sift/core/agent) reads evals/playbook/nda.yaml at request time via
  // fs.readFileSync — a plain data file, so webpack's module bundling doesn't pick it up on its
  // own. outputFileTracingIncludes tells Next's file tracer to ship it alongside the compiled
  // route so it's present in the deployed serverless function output. Path is relative to this
  // config file's directory (app/), matching how the file tracer resolves `dir`.
  outputFileTracingIncludes: {
    "/api/review": ["../evals/playbook/nda.yaml"],
  },
  webpack(config) {
    // Core uses ESM-style .js extensions on TypeScript source files.
    // Tell webpack to also look for .ts/.tsx when it sees a .js import.
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
    };
    return config;
  },
};

export default nextConfig;
