import { defineConfig, devices } from "@playwright/test";

const apiPort = 56012;
const webPort = 56011;

export default defineConfig({
  testDir: "./test/e2e",
  timeout: 30_000,
  fullyParallel: true,
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    trace: "on-first-retry",
  },
  webServer: [
    {
      command: `bash -lc 'pnpm tsx test/e2e/mock-api-server.ts'`,
      port: apiPort,
      env: {
        PORT: String(apiPort),
      },
      reuseExistingServer: false,
    },
    {
      command: `bash -lc 'GEMMA_AGENT_PWA_WEB_PORT=${webPort} GEMMA_AGENT_PWA_API_PROXY_TARGET=http://127.0.0.1:${apiPort} pnpm --filter @gemma-agent-pwa/web exec vite --host 127.0.0.1 --port ${webPort} --strictPort'`,
      port: webPort,
      reuseExistingServer: false,
    },
  ],
  projects: [
    {
      name: "mobile-chromium",
      use: {
        ...devices["Pixel 7"],
      },
    },
  ],
});
