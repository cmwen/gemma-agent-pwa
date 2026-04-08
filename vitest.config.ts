import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@gemma-agent-pwa/contracts": path.resolve(
        __dirname,
        "packages/contracts/src/index.ts"
      ),
      "@gemma-agent-pwa/min-kb-bridge": path.resolve(
        __dirname,
        "packages/min-kb-bridge/src/index.ts"
      ),
    },
  },
  test: {
    environment: "node",
    include: [
      "apps/**/*.test.ts",
      "packages/**/*.test.ts",
      "test/**/*.test.ts",
    ],
    exclude: ["**/dist/**", "**/node_modules/**", "test/e2e/**"],
  },
});
