/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@sift/core"],
  // Keep Node-only deps out of the client/edge bundle.
  // Next 15+ option (replaces experimental.serverComponentsExternalPackages).
  serverExternalPackages: ["@huggingface/transformers", "pg"],
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
