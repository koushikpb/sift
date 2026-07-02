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

// Default PLAYBOOK_PATH the same way, for the same reason: @sift/core/agent's own
// import.meta.url-based fallback breaks once webpack bundles it (verified — see the comment on
// `playbookPath` in core/src/agent/index.ts: webpack rewrites `new URL(literal, import.meta.url)`
// into a static-asset reference that throws `Invalid URL` at runtime). next.config.mjs runs
// unbundled, so import.meta.url resolves correctly here; compute the real path once and let
// @sift/core/agent read it from process.env instead. An explicit PLAYBOOK_PATH (e.g. set in
// Vercel's dashboard, if the deployed layout differs) still wins — this only fills the gap.
if (!process.env.PLAYBOOK_PATH) {
  try {
    process.env.PLAYBOOK_PATH = fileURLToPath(new URL("../evals/playbook/nda.yaml", import.meta.url));
  } catch {
    // Leave unset — @sift/core/agent's own fallback (which will throw once bundled) surfaces
    // as a clean 500 via the review route's dependency-construction guard, not a crash.
  }
}

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
