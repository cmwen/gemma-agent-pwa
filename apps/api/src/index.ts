import { pathToFileURL } from "node:url";
import { resolveWorkspace } from "@gemma-agent-pwa/min-kb-bridge";
import { serve } from "@hono/node-server";
import { createApiApp } from "./app.js";

const port = Number(process.env.GEMMA_AGENT_PWA_PORT ?? 8787);

export { createApiApp } from "./app.js";

export async function startApiServer() {
  const workspace = await resolveWorkspace();
  const app = createApiApp(workspace);
  return serve(
    {
      fetch: app.fetch,
      port,
    },
    () => {
      console.info(`Gemma Agent API listening on http://localhost:${port}`);
    }
  );
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  await startApiServer();
}
