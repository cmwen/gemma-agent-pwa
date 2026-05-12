import { randomUUID } from "node:crypto";
import {
  type ChatRuntimeConfig,
  DEFAULT_MODEL,
  getPresetById,
  type ModelDescriptor,
  mergeRuntimeConfig,
  type PlannerRun,
  type PlannerRunCreate,
  type PlannerTask,
  plannerRunCreateSchema,
  plannerRunSchema,
} from "@gemma-agent-pwa/contracts";
import {
  getAgentById,
  getPlannerRun,
  listPlannerRuns,
  type MinKbWorkspace,
  recordSessionLlmUsage,
  saveChatTurn,
  upsertPlannerRun,
} from "@gemma-agent-pwa/min-kb-bridge";
import type { Hono } from "hono";
import { loadAgentSkills } from "./agent-skills.js";
import { runChatLoop } from "./chat-loop.js";
import { listAvailableModels } from "./llm-provider.js";

export function registerPlannerRunRoutes(
  app: Hono,
  workspace: MinKbWorkspace
): void {
  app.get("/api/planner-runs", async (context) => {
    const plannerAgentId = context.req.query("plannerAgentId");
    return context.json(await listPlannerRuns(workspace, plannerAgentId));
  });

  app.post("/api/planner-runs", async (context) => {
    const input = plannerRunCreateSchema.parse(
      (await context.req.json()) ?? {}
    );
    await requireAgent(workspace, input.plannerAgentId);
    for (const task of input.tasks) {
      await requireAgent(workspace, task.taskerAgentId);
    }
    const run = createPlannerRun(input);
    await upsertPlannerRun(workspace, run);
    return context.json(run, 201);
  });

  app.get("/api/planner-runs/:plannerAgentId/:runId", async (context) => {
    const plannerAgentId = context.req.param("plannerAgentId");
    await requireAgent(workspace, plannerAgentId);
    const run = await requirePlannerRun(
      workspace,
      plannerAgentId,
      context.req.param("runId")
    );
    return context.json(run);
  });

  app.post(
    "/api/planner-runs/:plannerAgentId/:runId/execute",
    async (context) => {
      const plannerAgentId = context.req.param("plannerAgentId");
      await requireAgent(workspace, plannerAgentId);
      const run = await requirePlannerRun(
        workspace,
        plannerAgentId,
        context.req.param("runId")
      );
      return context.json(await executePlannerRun(workspace, run));
    }
  );

  app.post(
    "/api/planner-runs/:plannerAgentId/:runId/resume",
    async (context) => {
      const plannerAgentId = context.req.param("plannerAgentId");
      await requireAgent(workspace, plannerAgentId);
      const run = await requirePlannerRun(
        workspace,
        plannerAgentId,
        context.req.param("runId")
      );
      return context.json(await executePlannerRun(workspace, run));
    }
  );
}

export function createPlannerRun(input: PlannerRunCreate): PlannerRun {
  const now = new Date().toISOString();
  const baseTitle =
    input.title?.trim() ||
    input.objective.split(/\r?\n/, 1)[0]?.trim() ||
    "Planner run";
  return plannerRunSchema.parse({
    runId: randomUUID(),
    plannerAgentId: input.plannerAgentId,
    title: baseTitle.slice(0, 160),
    objective: input.objective,
    status: "pending",
    createdAt: now,
    updatedAt: now,
    tasks: input.tasks.map((task, index) => ({
      id: task.id?.trim() || `task-${index + 1}`,
      title: task.title,
      taskerAgentId: task.taskerAgentId,
      prompt: task.prompt,
      status: "pending",
      attemptCount: 0,
    })),
  });
}

export async function executePlannerRun(
  workspace: MinKbWorkspace,
  run: PlannerRun
): Promise<PlannerRun> {
  const now = new Date().toISOString();
  let nextRun = await upsertPlannerRun(workspace, {
    ...run,
    status: "running",
    updatedAt: now,
    startedAt: run.startedAt ?? now,
    completedAt: undefined,
    lastError: undefined,
  });

  for (const task of nextRun.tasks) {
    if (task.status === "success") {
      continue;
    }

    nextRun = await markTaskRunning(workspace, nextRun, task.id);

    try {
      const result = await executePlannerTask(workspace, nextRun, task.id);
      nextRun = await markTaskSuccess(workspace, nextRun, task.id, result);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Planner task execution failed.";
      return markTaskError(workspace, nextRun, task.id, message);
    }
  }

  const completedAt = new Date().toISOString();
  return upsertPlannerRun(workspace, {
    ...nextRun,
    status: "success",
    updatedAt: completedAt,
    completedAt,
    lastError: undefined,
  });
}

async function markTaskRunning(
  workspace: MinKbWorkspace,
  run: PlannerRun,
  taskId: string
): Promise<PlannerRun> {
  const updatedAt = new Date().toISOString();
  return upsertPlannerRun(workspace, {
    ...run,
    status: "running",
    updatedAt,
    tasks: run.tasks.map((task) =>
      task.id === taskId
        ? {
            ...task,
            status: "running",
            startedAt: updatedAt,
            completedAt: undefined,
            lastError: undefined,
            attemptCount: task.attemptCount + 1,
          }
        : task
    ),
  });
}

async function markTaskSuccess(
  workspace: MinKbWorkspace,
  run: PlannerRun,
  taskId: string,
  result: {
    sessionId: string;
    assistantSummary: string;
  }
): Promise<PlannerRun> {
  const updatedAt = new Date().toISOString();
  return upsertPlannerRun(workspace, {
    ...run,
    status: "running",
    updatedAt,
    tasks: run.tasks.map((task) =>
      task.id === taskId
        ? {
            ...task,
            status: "success",
            completedAt: updatedAt,
            lastError: undefined,
            resultSessionId: result.sessionId,
            resultSummary: result.assistantSummary,
          }
        : task
    ),
  });
}

async function markTaskError(
  workspace: MinKbWorkspace,
  run: PlannerRun,
  taskId: string,
  errorMessage: string
): Promise<PlannerRun> {
  const updatedAt = new Date().toISOString();
  const failedTask = run.tasks.find((task) => task.id === taskId);
  return upsertPlannerRun(workspace, {
    ...run,
    status: "error",
    updatedAt,
    completedAt: updatedAt,
    lastError: failedTask
      ? `Task "${failedTask.title}" failed: ${errorMessage}`
      : errorMessage,
    tasks: run.tasks.map((task) =>
      task.id === taskId
        ? {
            ...task,
            status: "error",
            completedAt: updatedAt,
            lastError: errorMessage,
          }
        : task
    ),
  });
}

async function executePlannerTask(
  workspace: MinKbWorkspace,
  run: PlannerRun,
  taskId: string
): Promise<{
  sessionId: string;
  assistantSummary: string;
}> {
  const task = requireTask(run, taskId);
  const taskerAgent = await requireAgent(workspace, task.taskerAgentId);
  const models = await listAvailableModels();
  const runtimeConfig = selectTaskerRuntimeConfig(
    taskerAgent.runtimeConfig,
    models
  );
  const sessionId = buildTaskerSessionId(run.runId, task.id);
  const sessionTitle = `${run.title} · ${task.title}`;
  const userThread = await saveChatTurn(workspace, {
    agentId: task.taskerAgentId,
    sender: "user",
    bodyMarkdown: task.prompt,
    title: sessionTitle,
    sessionId,
    runtimeConfig,
  });
  const enabledSkills = await loadAgentSkills(
    workspace,
    task.taskerAgentId,
    runtimeConfig.disabledSkills
  );
  const loopResult = await runChatLoop({
    agentId: task.taskerAgentId,
    agentPrompt: taskerAgent.combinedPrompt,
    config: runtimeConfig,
    conversationTurns: userThread.turns,
    enabledSkills,
    sessionId: userThread.sessionId,
  });
  const assistantSummary = summarizeThread(loopResult.assistantText);
  await saveChatTurn(workspace, {
    agentId: task.taskerAgentId,
    sender: "assistant",
    bodyMarkdown: loopResult.assistantText,
    thinkingMarkdown: loopResult.thinkingText,
    title: userThread.title,
    sessionId: userThread.sessionId,
    runtimeConfig,
    summary: assistantSummary,
  });
  await recordSessionLlmUsage(
    workspace,
    task.taskerAgentId,
    userThread.sessionId,
    {
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
    }
  );
  return {
    sessionId: userThread.sessionId,
    assistantSummary,
  };
}

function selectTaskerRuntimeConfig(
  agentConfig: ChatRuntimeConfig | undefined,
  models: ModelDescriptor[]
): ChatRuntimeConfig {
  const defaultModel =
    chooseDefaultModel(models)?.id ?? agentConfig?.model ?? DEFAULT_MODEL;
  return mergeRuntimeConfig({ model: defaultModel }, agentConfig);
}

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

function buildTaskerSessionId(runId: string, taskId: string): string {
  return `planner-${normalizeIdPart(runId)}-task-${normalizeIdPart(taskId)}`;
}

function normalizeIdPart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
}

async function requireAgent(workspace: MinKbWorkspace, agentId: string) {
  const agent = await getAgentById(workspace, agentId);
  if (!agent) {
    throw new Error(`Agent not found: ${agentId}`);
  }
  return agent;
}

async function requirePlannerRun(
  workspace: MinKbWorkspace,
  plannerAgentId: string,
  runId: string
): Promise<PlannerRun> {
  const run = await getPlannerRun(workspace, plannerAgentId, runId);
  if (!run) {
    throw new Error(
      `Planner run not found for planner ${plannerAgentId}: ${runId}`
    );
  }
  return run;
}

function requireTask(run: PlannerRun, taskId: string): PlannerTask {
  const task = run.tasks.find((entry) => entry.id === taskId);
  if (!task) {
    throw new Error(`Planner task not found in run ${run.runId}: ${taskId}`);
  }
  return task;
}

export const __testing = {
  buildTaskerSessionId,
  createPlannerRun,
  normalizeIdPart,
};
