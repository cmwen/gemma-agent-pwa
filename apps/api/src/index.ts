import {
  type ChatRequest,
  chatRequestSchema,
  chatStreamEventSchema,
  DEFAULT_MODEL,
  getPresetById,
  type ModelDescriptor,
  mergeRuntimeConfig,
} from "@gemma-agent-pwa/contracts";
import {
  getAgentById,
  getSession,
  listAgents,
  listSessions,
  loadEnabledSkillDocumentsForAgent,
  recordSessionLlmUsage,
  resolveWorkspace,
  saveChatTurn,
  summarizeWorkspace,
} from "@gemma-agent-pwa/min-kb-bridge";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamText } from "hono/streaming";
import { getDetectedWebOrigins, splitCsv } from "../../../scripts/network.js";
import {
  getLmStudioModelCatalog,
  listLmStudioModels,
  streamLmStudioChat,
} from "./lmstudio.js";

const workspace = await resolveWorkspace();
const app = new Hono();
const port = Number(process.env.GEMMA_AGENT_PWA_PORT ?? 8787);
const allowedCorsOrigins = getAllowedCorsOrigins();

app.use(
  "/api/*",
  cors({
    origin: (origin) => (isAllowedCorsOrigin(origin) ? origin : null),
    allowHeaders: ["Content-Type"],
    allowMethods: ["GET", "POST", "OPTIONS"],
  })
);

app.onError((error, context) => {
  console.error(error);
  return context.json({ error: error.message }, 500);
});

app.get("/api/health", async (context) => {
  const workspaceSummary = await summarizeWorkspace(workspace);
  const { models, reachable: lmStudioReachable } =
    await getLmStudioModelCatalog();
  const defaultModel = chooseDefaultModel(models);
  return context.json({
    ok: true,
    workspace: workspaceSummary,
    lmStudioReachable,
    ...(defaultModel ? { defaultModel: defaultModel.id } : {}),
    ...(lmStudioReachable && defaultModel
      ? { warmedModel: defaultModel.id }
      : {}),
    modelCount: models.length,
    message: lmStudioReachable
      ? "LM Studio is reachable and ready for local chat."
      : defaultModel
        ? "LM Studio is unavailable. A configured model is ready once the server comes online."
        : "LM Studio is unavailable. You can still browse history and agents.",
  });
});

app.get("/api/models", async (context) => {
  return context.json(await listLmStudioModels());
});

app.get("/api/agents", async (context) => {
  return context.json(await listAgents(workspace));
});

app.get("/api/agents/:agentId", async (context) => {
  const agent = await getAgentById(workspace, context.req.param("agentId"));
  if (!agent) {
    return context.json({ error: "Agent not found." }, 404);
  }
  return context.json(agent);
});

app.get("/api/agents/:agentId/sessions", async (context) => {
  return context.json(
    await listSessions(workspace, context.req.param("agentId"))
  );
});

app.get("/api/agents/:agentId/sessions/:sessionId", async (context) => {
  return context.json(
    await getSession(
      workspace,
      context.req.param("agentId"),
      context.req.param("sessionId")
    )
  );
});

app.post("/api/agents/:agentId/chat", async (context) => {
  const agentId = context.req.param("agentId");
  const request = chatRequestSchema.parse(
    ((await context.req.json()) ?? {}) satisfies ChatRequest
  );
  const agent = await getAgentById(workspace, agentId);
  if (!agent) {
    return context.json({ error: "Agent not found." }, 404);
  }

  const existingThread = request.sessionId
    ? await getSession(workspace, agentId, request.sessionId).catch(
        () => undefined
      )
    : undefined;
  const availableModels = await listLmStudioModels();
  const defaultModel = chooseDefaultModel(availableModels)?.id ?? DEFAULT_MODEL;
  const mergedConfig = mergeRuntimeConfig(
    { model: defaultModel },
    agent.runtimeConfig,
    existingThread?.runtimeConfig,
    request.config
  );
  const prompt = request.prompt.trim();
  const title =
    request.title?.trim() ||
    existingThread?.title ||
    prompt.slice(0, 72) ||
    "New Gemma chat";
  const userThread = await saveChatTurn(workspace, {
    agentId,
    sender: "user",
    bodyMarkdown: prompt,
    title,
    sessionId: existingThread?.sessionId ?? request.sessionId,
    runtimeConfig: mergedConfig,
  });
  const enabledSkills = await loadEnabledSkillDocumentsForAgent(
    workspace,
    agentId,
    mergedConfig.disabledSkills
  );

  return streamText(context, async (stream) => {
    const sendEvent = async (event: unknown) => {
      await stream.writeln(JSON.stringify(chatStreamEventSchema.parse(event)));
    };

    try {
      await sendEvent({
        type: "thread",
        thread: userThread,
      });
      const result = await streamLmStudioChat({
        model: mergedConfig.model,
        config: mergedConfig,
        conversation: userThread.turns,
        agentPrompt: agent.combinedPrompt,
        enabledSkills,
        onSnapshot: (snapshot) => {
          void sendEvent({
            type: "assistant_snapshot",
            ...snapshot,
          });
        },
      });
      const completedThread = await saveChatTurn(workspace, {
        agentId,
        sender: "assistant",
        bodyMarkdown: result.assistantText,
        thinkingMarkdown: result.thinkingText,
        title: userThread.title,
        sessionId: userThread.sessionId,
        runtimeConfig: mergedConfig,
        summary: summarizeThread(result.assistantText),
      });
      await recordSessionLlmUsage(
        workspace,
        agentId,
        completedThread.sessionId,
        result.llmStats
      );
      const threadWithUsage = await getSession(
        workspace,
        agentId,
        completedThread.sessionId
      );
      const assistantTurn = threadWithUsage.turns.at(-1);
      if (!assistantTurn) {
        throw new Error("Assistant turn was not persisted.");
      }
      await sendEvent({
        type: "complete",
        response: {
          thread: threadWithUsage,
          assistantTurn,
        },
      });
    } catch (error) {
      await sendEvent({
        type: "error",
        error:
          error instanceof Error ? error.message : "Unknown LM Studio error.",
      });
    }
  });
});

serve(
  {
    fetch: app.fetch,
    port,
  },
  () => {
    console.info(`Gemma Agent API listening on http://localhost:${port}`);
  }
);

function chooseDefaultModel(
  models: ModelDescriptor[]
): ModelDescriptor | undefined {
  return (
    models.find((model) => /gemma-4/i.test(model.id)) ??
    models.find((model) => model.isGemma) ??
    models[0]
  );
}

function summarizeThread(assistantText: string): string {
  const firstSentence = assistantText
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .find((sentence) => sentence.trim().length > 0);
  return firstSentence?.slice(0, 240) ?? getPresetById().description;
}

function getAllowedCorsOrigins(): Set<string> {
  const configuredOrigins = splitCsv(process.env.GEMMA_AGENT_PWA_CORS_ORIGINS);

  return new Set([
    ...getDetectedWebOrigins(4173),
    ...getDetectedWebOrigins(5173),
    ...getDetectedWebOrigins(55006),
    ...configuredOrigins,
  ]);
}

function isAllowedCorsOrigin(origin: string): boolean {
  if (allowedCorsOrigins.has(origin)) {
    return true;
  }

  try {
    return new URL(origin).hostname.endsWith(".github.io");
  } catch {
    return false;
  }
}
