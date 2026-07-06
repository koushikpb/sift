import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // `test/**` is the historical convention; `src/**` is co-located (e.g. serve/reviewStream.test.ts).
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    testTimeout: 30000,
  },
});
