import {
  type ChatRequest,
  chatRequestSchema,
  chatStreamEventSchema,
  DEFAULT_MODEL,
  getPresetById,
  type ModelDescriptor,
  mergeRuntimeConfig,
  sessionDeleteModeSchema,
  sessionListStateSchema,
} from "@gemma-agent-pwa/contracts";
import {
  deleteSession,
  getAgentById,
  getSession,
  listAgents,
  listSessions,
  recordSessionLlmUsage,
  resolveWorkspace,
  restoreSession,
  saveChatTurn,
  softDeleteSession,
  summarizeWorkspace,
} from "@gemma-agent-pwa/min-kb-bridge";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamText } from "hono/streaming";
import { getDetectedWebOrigins, splitCsv } from "../../../scripts/network.js";
import { loadAgentSkills } from "./agent-skills.js";
import {
  buildChatRequestDebugLog,
  buildChatStreamDebugLog,
  buildSkillInventoryDebugLog,
  logChatDebugMessage,
} from "./chat-debug.js";
import { runChatLoop } from "./chat-loop.js";
import { getLmStudioModelCatalog, listLmStudioModels } from "./lmstudio.js";

const workspace = await resolveWorkspace();
const app = new Hono();
const port = Number(process.env.GEMMA_AGENT_PWA_PORT ?? 8787);
const allowedCorsOrigins = getAllowedCorsOrigins();

app.use(
  "/api/*",
  cors({
    origin: (origin) => (isAllowedCorsOrigin(origin) ? origin : null),
    allowHeaders: ["Content-Type"],
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
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
  const state = sessionListStateSchema.parse(
    context.req.query("state") ?? "active"
  );
  return context.json(
    await listSessions(workspace, context.req.param("agentId"), { state })
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

app.delete("/api/agents/:agentId/sessions/:sessionId", async (context) => {
  const mode = sessionDeleteModeSchema.parse(
    context.req.query("mode") ?? "soft"
  );
  if (mode === "soft") {
    await softDeleteSession(
      workspace,
      context.req.param("agentId"),
      context.req.param("sessionId")
    );
  } else {
    await deleteSession(
      workspace,
      context.req.param("agentId"),
      context.req.param("sessionId")
    );
  }
  return context.body(null, 204);
});

app.post(
  "/api/agents/:agentId/sessions/:sessionId/restore",
  async (context) => {
    await restoreSession(
      workspace,
      context.req.param("agentId"),
      context.req.param("sessionId")
    );
    return context.body(null, 204);
  }
);

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
  const enabledSkills = await loadAgentSkills(
    workspace,
    agentId,
    mergedConfig.disabledSkills
  );
  logChatDebugMessage(
    buildChatRequestDebugLog({
      agentId,
      sessionId: userThread.sessionId,
      title,
      prompt,
      runtimeConfig: mergedConfig,
    })
  );
  logChatDebugMessage(
    buildSkillInventoryDebugLog(
      {
        agentId,
        sessionId: userThread.sessionId,
      },
      {
        executableSkillCount: enabledSkills.filter((skill) => skill.hasScript)
          .length,
        skillNames: enabledSkills.map((skill) => skill.name),
      }
    )
  );

  return streamText(context, async (stream) => {
    const sendEvent = async (event: unknown) => {
      const parsedEvent = chatStreamEventSchema.parse(event);
      logChatDebugMessage(
        buildChatStreamDebugLog(parsedEvent, {
          agentId,
          sessionId: userThread.sessionId,
        })
      );
      await stream.writeln(JSON.stringify(parsedEvent));
    };
    let pendingWrite = Promise.resolve();
    const queueEvent = (event: unknown) => {
      pendingWrite = pendingWrite.then(() => sendEvent(event));
      return pendingWrite;
    };

    try {
      await queueEvent({
        type: "thread",
        thread: userThread,
      });

      const loopResult = await runChatLoop({
        agentId,
        agentPrompt: agent.combinedPrompt,
        config: mergedConfig,
        conversationTurns: userThread.turns,
        enabledSkills,
        sessionId: userThread.sessionId,
        emitEvent: queueEvent,
      });

      const completedThread = await saveChatTurn(workspace, {
        agentId,
        sender: "assistant",
        bodyMarkdown: loopResult.assistantText,
        thinkingMarkdown: loopResult.thinkingText,
        title: userThread.title,
        sessionId: userThread.sessionId,
        runtimeConfig: mergedConfig,
        summary: summarizeThread(loopResult.assistantText),
      });
      const llmStatsWithRate = {
        ...loopResult.llmStats,
        ...(loopResult.llmStats.outputTokens > 0 &&
        loopResult.llmStats.durationMs > 0
          ? {
              tokensPerSecond: Number(
                (
                  (loopResult.llmStats.outputTokens /
                    loopResult.llmStats.durationMs) *
                  1000
                ).toFixed(2)
              ),
            }
          : {}),
      };
      await recordSessionLlmUsage(
        workspace,
        agentId,
        completedThread.sessionId,
        llmStatsWithRate
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
      await pendingWrite;
      await queueEvent({
        type: "complete",
        response: {
          thread: threadWithUsage,
          assistantTurn,
        },
      });
    } catch (error) {
      await pendingWrite;
      await queueEvent({
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
    ...getDetectedWebOrigins(80),
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
