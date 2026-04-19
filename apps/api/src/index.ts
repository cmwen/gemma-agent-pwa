import {
  type ChatRequest,
  type ChatTurn,
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
import {
  executeSkillScript,
  parseSkillCalls,
  stripSkillCalls,
} from "./skill-executor.js";

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

const MAX_SKILL_LOOP_ITERATIONS = 5;

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

      const conversationTurns: ChatTurn[] = [...userThread.turns];
      let finalAssistantText = "";
      let finalThinkingText: string | undefined;
      const totalLlmStats = {
        recordedAt: new Date().toISOString(),
        model: mergedConfig.model,
        requestCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        durationMs: 0,
      };

      for (
        let iteration = 0;
        iteration < MAX_SKILL_LOOP_ITERATIONS;
        iteration++
      ) {
        const result = await streamLmStudioChat({
          model: mergedConfig.model,
          config: mergedConfig,
          conversation: conversationTurns,
          agentPrompt: agent.combinedPrompt,
          enabledSkills,
          onSnapshot: (snapshot) => {
            void queueEvent({
              type: "assistant_snapshot",
              ...snapshot,
            });
          },
        });

        totalLlmStats.requestCount += result.llmStats.requestCount;
        totalLlmStats.inputTokens += result.llmStats.inputTokens;
        totalLlmStats.outputTokens += result.llmStats.outputTokens;
        totalLlmStats.durationMs += result.llmStats.durationMs;

        const skillCalls = parseSkillCalls(result.assistantText);
        if (skillCalls.length === 0) {
          finalAssistantText = result.assistantText;
          finalThinkingText = result.thinkingText;
          break;
        }

        // Execute skill calls and feed results back
        const assistantTextWithoutCalls = stripSkillCalls(result.assistantText);
        conversationTurns.push({
          messageId: `loop-assistant-${iteration}`,
          sender: "assistant",
          createdAt: new Date().toISOString(),
          bodyMarkdown: result.assistantText,
          relativePath: "in-flight",
        });

        for (const call of skillCalls) {
          const skill = enabledSkills.find(
            (s) => s.name === call.skillName && s.hasScript
          );

          await queueEvent({
            type: "skill_call",
            skillName: call.skillName,
            skillInput: call.input,
          });

          let skillResult: {
            skillName: string;
            output: string;
            exitCode: number;
          };
          if (skill) {
            skillResult = await executeSkillScript(skill, call.input);
          } else {
            skillResult = {
              skillName: call.skillName,
              output: `Skill "${call.skillName}" is not available or has no executable script.`,
              exitCode: 1,
            };
          }

          await queueEvent({
            type: "skill_result",
            skillName: skillResult.skillName,
            skillOutput: skillResult.output,
            exitCode: skillResult.exitCode,
          });

          conversationTurns.push({
            messageId: `loop-tool-${iteration}-${call.skillName}`,
            sender: "tool",
            createdAt: new Date().toISOString(),
            bodyMarkdown: `[Skill result: ${call.skillName} (exit code ${skillResult.exitCode})]\n\n${skillResult.output}`,
            relativePath: "in-flight",
          });
        }

        // If this was the last iteration, use whatever we have
        if (iteration === MAX_SKILL_LOOP_ITERATIONS - 1) {
          finalAssistantText =
            assistantTextWithoutCalls || result.assistantText;
          finalThinkingText = result.thinkingText;
        }
      }

      if (!finalAssistantText) {
        throw new Error("LM Studio returned no assistant message content.");
      }

      const completedThread = await saveChatTurn(workspace, {
        agentId,
        sender: "assistant",
        bodyMarkdown: finalAssistantText,
        thinkingMarkdown: finalThinkingText,
        title: userThread.title,
        sessionId: userThread.sessionId,
        runtimeConfig: mergedConfig,
        summary: summarizeThread(finalAssistantText),
      });
      const llmStatsWithRate = {
        ...totalLlmStats,
        ...(totalLlmStats.outputTokens > 0 && totalLlmStats.durationMs > 0
          ? {
              tokensPerSecond: Number(
                (
                  (totalLlmStats.outputTokens / totalLlmStats.durationMs) *
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
