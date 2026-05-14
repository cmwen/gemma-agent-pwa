import { randomUUID } from "node:crypto";
import {
  type ChatRuntimeConfig,
  createDelegationTool,
  DEFAULT_MODEL,
  getPresetById,
  type ModelDescriptor,
  mergeRuntimeConfig,
  type ScheduledTask,
  type ScheduledTaskCreate,
  type ScheduledTaskRun,
  type ScheduledTaskRunTrigger,
  type ScheduledTaskUpdate,
  scheduledTaskCreateSchema,
  scheduledTaskSchema,
  scheduledTaskUpdateSchema,
} from "@gemma-agent-pwa/contracts";
import {
  deleteScheduledTask as deleteScheduledTaskRecord,
  getAgentById,
  getScheduledTask,
  listScheduledTasks,
  type MinKbWorkspace,
  recordSessionLlmUsage,
  saveChatTurn,
  upsertScheduledTask,
} from "@gemma-agent-pwa/min-kb-bridge";
import type { Hono } from "hono";
import { loadAgentSkills } from "./agent-skills.js";
import { runChatLoop } from "./chat-loop.js";
import { executeDelegatedAgentTool } from "./delegation.js";
import { listAvailableModels } from "./llm-provider.js";
import { buildRuntimeTools, executeRuntimeToolCall } from "./tool-runtime.js";

const RUN_HISTORY_LIMIT = 20;
const SCHEDULER_MIN_INTERVAL_MS = 30_000;
const SCHEDULER_MAX_INTERVAL_MS = 3_600_000;
const NEXT_RUN_SEARCH_MINUTES = 8 * 24 * 60;

export function registerScheduledTaskRoutes(
  app: Hono,
  workspace: MinKbWorkspace,
  options: {
    onScheduleMutation?: () => void;
  } = {}
): void {
  app.get("/api/schedules", async (context) => {
    return context.json(await listScheduledTasks(workspace));
  });

  app.get("/api/agents/:agentId/schedules", async (context) => {
    const agentId = context.req.param("agentId");
    await requireAgent(workspace, agentId);
    return context.json(await listScheduledTasks(workspace, agentId));
  });

  app.post("/api/agents/:agentId/schedules", async (context) => {
    const agentId = context.req.param("agentId");
    await requireAgent(workspace, agentId);
    const input = scheduledTaskCreateSchema.parse(
      (await context.req.json()) ?? {}
    );
    const task = buildScheduledTask({
      ...input,
      agentId,
    });
    await upsertScheduledTask(workspace, task);
    options.onScheduleMutation?.();
    return context.json(task, 201);
  });

  app.patch("/api/agents/:agentId/schedules/:taskId", async (context) => {
    const agentId = context.req.param("agentId");
    await requireAgent(workspace, agentId);
    const existing = await requireScheduledTask(
      workspace,
      agentId,
      context.req.param("taskId")
    );
    const input = scheduledTaskUpdateSchema.parse(
      (await context.req.json()) ?? {}
    );
    const task = applyScheduledTaskUpdate(existing, input);
    await upsertScheduledTask(workspace, task);
    options.onScheduleMutation?.();
    return context.json(task);
  });

  app.delete("/api/agents/:agentId/schedules/:taskId", async (context) => {
    const agentId = context.req.param("agentId");
    await requireAgent(workspace, agentId);
    await deleteScheduledTaskRecord(
      workspace,
      agentId,
      context.req.param("taskId")
    );
    options.onScheduleMutation?.();
    return context.body(null, 204);
  });

  app.post("/api/agents/:agentId/schedules/:taskId/run", async (context) => {
    const agentId = context.req.param("agentId");
    await requireAgent(workspace, agentId);
    const task = await requireScheduledTask(
      workspace,
      agentId,
      context.req.param("taskId")
    );
    if (task.runningAt) {
      return context.json({ error: "Scheduled task is already running." }, 409);
    }
    const updatedTask = await runScheduledTask(workspace, task, {
      trigger: "manual",
    });
    options.onScheduleMutation?.();
    return context.json(updatedTask);
  });
}

export function startScheduledTaskRunner(options: {
  workspace: MinKbWorkspace;
  intervalMs?: number;
  now?: () => Date;
}): {
  refresh: () => void;
  stop: () => void;
} {
  const minimumIntervalMs = options.intervalMs ?? SCHEDULER_MIN_INTERVAL_MS;
  let running = false;
  let stopped = false;
  let handle: ReturnType<typeof setTimeout> | undefined;
  let refreshRequested = false;

  const clearScheduledTick = () => {
    if (handle) {
      clearTimeout(handle);
      handle = undefined;
    }
  };

  const scheduleNextTick = (delayMs: number) => {
    if (stopped) {
      return;
    }
    clearScheduledTick();
    handle = setTimeout(() => {
      handle = undefined;
      void tick();
    }, delayMs);
  };

  const tick = async () => {
    if (running || stopped) {
      return;
    }
    running = true;
    refreshRequested = false;
    let nextDelayMs = minimumIntervalMs;
    try {
      let now = options.now?.() ?? new Date();
      const tasks = await listScheduledTasks(options.workspace);
      const nextTasks = [...tasks];
      for (const [index, task] of tasks.entries()) {
        if (!isTaskDue(task, now)) {
          continue;
        }
        nextTasks[index] = await runScheduledTask(options.workspace, task, {
          now,
          trigger:
            now.getTime() - new Date(task.nextRunAt).getTime() > 60_000
              ? "catch-up"
              : "schedule",
        });
        now = options.now?.() ?? new Date();
      }
      nextDelayMs = getSchedulerDelayMs(nextTasks, now, minimumIntervalMs);
    } catch (error) {
      console.error("Scheduled task runner tick failed.", error);
    } finally {
      running = false;
      scheduleNextTick(refreshRequested ? 0 : nextDelayMs);
    }
  };

  const refresh = () => {
    if (stopped) {
      return;
    }
    if (running) {
      refreshRequested = true;
      return;
    }
    scheduleNextTick(0);
  };

  void tick();
  return {
    refresh,
    stop: () => {
      stopped = true;
      clearScheduledTick();
    },
  };
}

export function buildScheduledTask(input: ScheduledTaskCreate): ScheduledTask {
  assertTimeZone(input.timezone);
  const createdAt = new Date().toISOString();
  const task = scheduledTaskSchema.parse({
    ...input,
    id: randomUUID(),
    createdAt,
    updatedAt: createdAt,
    nextRunAt: createdAt,
    recentRuns: [],
  });
  return {
    ...task,
    nextRunAt: computeNextScheduledRun(task, new Date(createdAt)),
  };
}

export function applyScheduledTaskUpdate(
  existing: ScheduledTask,
  updates: ScheduledTaskUpdate
): ScheduledTask {
  const updatedAt = new Date().toISOString();
  const merged = scheduledTaskSchema.parse({
    ...existing,
    ...updates,
    updatedAt,
    nextRunAt: existing.nextRunAt,
  });
  assertTimeZone(merged.timezone);
  const scheduleChanged =
    merged.recurrence !== existing.recurrence ||
    merged.minuteOfHour !== existing.minuteOfHour ||
    merged.hourOfDay !== existing.hourOfDay ||
    merged.dayOfWeek !== existing.dayOfWeek ||
    merged.timezone !== existing.timezone;
  const shouldRecomputeNextRun =
    scheduleChanged ||
    (!existing.enabled && merged.enabled) ||
    new Date(merged.nextRunAt).getTime() <= Date.now();

  return {
    ...merged,
    nextRunAt: shouldRecomputeNextRun
      ? computeNextScheduledRun(merged, new Date(updatedAt))
      : merged.nextRunAt,
  };
}

export function computeNextScheduledRun(
  task: Pick<
    ScheduledTask,
    "dayOfWeek" | "hourOfDay" | "minuteOfHour" | "recurrence" | "timezone"
  >,
  from: Date
): string {
  let candidate = ceilToNextMinute(from);
  for (let minute = 0; minute < NEXT_RUN_SEARCH_MINUTES; minute += 1) {
    if (matchesSchedule(task, getTimeZoneParts(candidate, task.timezone))) {
      return candidate.toISOString();
    }
    candidate = new Date(candidate.getTime() + 60_000);
  }
  throw new Error("Unable to resolve the next run for the scheduled task.");
}

export async function runScheduledTask(
  workspace: MinKbWorkspace,
  task: ScheduledTask,
  options: {
    now?: Date;
    trigger: ScheduledTaskRunTrigger;
  }
): Promise<ScheduledTask> {
  const startedAt = options.now?.toISOString() ?? new Date().toISOString();
  const scheduledFor =
    options.trigger === "manual" ? startedAt : task.nextRunAt || startedAt;
  const runningRun: ScheduledTaskRun = {
    runId: randomUUID(),
    status: "running",
    trigger: options.trigger,
    scheduledFor,
    startedAt,
  };
  const runningTask = await upsertScheduledTask(workspace, {
    ...task,
    runningAt: startedAt,
    updatedAt: startedAt,
    recentRuns: trimRunHistory([runningRun, ...task.recentRuns]),
  });

  try {
    const execution = await executeScheduledChat(
      workspace,
      runningTask,
      startedAt
    );
    const completedAt = new Date().toISOString();
    return await upsertScheduledTask(workspace, {
      ...runningTask,
      updatedAt: completedAt,
      nextRunAt:
        options.trigger === "manual"
          ? runningTask.nextRunAt
          : computeNextScheduledRun(runningTask, new Date(completedAt)),
      lastRunAt: completedAt,
      lastRunStatus: "success",
      lastRunError: undefined,
      lastSessionId: execution.sessionId,
      lastAssistantSummary: execution.assistantSummary,
      runningAt: undefined,
      recentRuns: trimRunHistory([
        {
          ...runningRun,
          status: "success",
          completedAt,
          sessionId: execution.sessionId,
          assistantSummary: execution.assistantSummary,
        },
        ...runningTask.recentRuns.filter(
          (entry) => entry.runId !== runningRun.runId
        ),
      ]),
    });
  } catch (error) {
    const completedAt = new Date().toISOString();
    return await upsertScheduledTask(workspace, {
      ...runningTask,
      updatedAt: completedAt,
      nextRunAt:
        options.trigger === "manual"
          ? runningTask.nextRunAt
          : computeNextScheduledRun(runningTask, new Date(completedAt)),
      lastRunAt: completedAt,
      lastRunStatus: "error",
      lastRunError:
        error instanceof Error ? error.message : "Scheduled task failed.",
      runningAt: undefined,
      recentRuns: trimRunHistory([
        {
          ...runningRun,
          status: "error",
          completedAt,
          errorMessage:
            error instanceof Error ? error.message : "Scheduled task failed.",
        },
        ...runningTask.recentRuns.filter(
          (entry) => entry.runId !== runningRun.runId
        ),
      ]),
    });
  }
}

function isTaskDue(task: ScheduledTask, now: Date): boolean {
  return (
    task.enabled &&
    !task.runningAt &&
    new Date(task.nextRunAt).getTime() <= now.getTime()
  );
}

function getSchedulerDelayMs(
  tasks: ScheduledTask[],
  now: Date,
  minimumIntervalMs: number
): number {
  const enabledTasks = tasks.filter((task) => task.enabled && !task.runningAt);
  if (enabledTasks.length === 0) {
    return SCHEDULER_MAX_INTERVAL_MS;
  }

  const nextDueAtMs = Math.min(
    ...enabledTasks.map((task) => new Date(task.nextRunAt).getTime())
  );
  return clampSchedulerDelayMs(nextDueAtMs - now.getTime(), minimumIntervalMs);
}

function clampSchedulerDelayMs(
  delayMs: number,
  minimumIntervalMs: number
): number {
  return Math.min(
    SCHEDULER_MAX_INTERVAL_MS,
    Math.max(minimumIntervalMs, delayMs)
  );
}

async function executeScheduledChat(
  workspace: MinKbWorkspace,
  task: ScheduledTask,
  startedAt: string
): Promise<{ assistantSummary: string; sessionId: string }> {
  const agent = await requireAgent(workspace, task.agentId);
  const models = await listAvailableModels();
  const runtimeConfig = selectScheduledTaskRuntimeConfig(
    agent.runtimeConfig,
    models
  );
  const sessionTitle =
    task.sessionMode === "fresh"
      ? `${task.title} · ${new Date(startedAt).toLocaleString([], {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        })}`
      : task.title;
  const userThread = await saveChatTurn(workspace, {
    agentId: task.agentId,
    sender: "user",
    bodyMarkdown: task.prompt,
    title: sessionTitle,
    sessionId:
      task.sessionMode === "dedicated" ? `schedule-${task.id}` : undefined,
    runtimeConfig,
  });
  const enabledSkills = await loadAgentSkills(
    workspace,
    task.agentId,
    runtimeConfig.disabledSkills
  );
  const delegationTool = createDelegationTool({
    agentTitle: agent.title,
    delegatedAgentIds: agent.delegatedAgentIds ?? [],
  });
  const tools = buildRuntimeTools({
    enabledSkills,
    delegationTool,
  });
  const loopResult = await runChatLoop({
    agentId: task.agentId,
    agentKind: agent.kind,
    agentPrompt: agent.combinedPrompt,
    config: runtimeConfig,
    conversationTurns: userThread.turns,
    enabledSkills,
    tools,
    sessionId: userThread.sessionId,
    executeToolCall: (call) =>
      executeRuntimeToolCall(call, {
        enabledSkills,
        executeDelegation: (callInput) =>
          executeDelegatedAgentTool(
            workspace,
            {
              allowedAgentIds: agent.delegatedAgentIds ?? [],
              parentAgentId: task.agentId,
              parentSessionId: userThread.sessionId,
              parentAgentTitle: agent.title,
              parentConfig: runtimeConfig,
            },
            callInput
          ),
      }),
  });
  await saveChatTurn(workspace, {
    agentId: task.agentId,
    sender: "assistant",
    bodyMarkdown: loopResult.assistantText,
    thinkingMarkdown: loopResult.thinkingText,
    title: userThread.title,
    sessionId: userThread.sessionId,
    runtimeConfig,
    summary: summarizeThread(loopResult.assistantText),
  });
  await recordSessionLlmUsage(workspace, task.agentId, userThread.sessionId, {
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
  });
  return {
    assistantSummary: summarizeThread(loopResult.assistantText),
    sessionId: userThread.sessionId,
  };
}

async function requireAgent(workspace: MinKbWorkspace, agentId: string) {
  const agent = await getAgentById(workspace, agentId);
  if (!agent) {
    throw new Error(`Agent not found: ${agentId}`);
  }
  return agent;
}

async function requireScheduledTask(
  workspace: MinKbWorkspace,
  agentId: string,
  taskId: string
): Promise<ScheduledTask> {
  const task = await getScheduledTask(workspace, agentId, taskId);
  if (!task) {
    throw new Error(`Scheduled task not found for agent ${agentId}: ${taskId}`);
  }
  return task;
}

function selectScheduledTaskRuntimeConfig(
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

function trimRunHistory(runs: ScheduledTaskRun[]): ScheduledTaskRun[] {
  return runs.slice(0, RUN_HISTORY_LIMIT);
}

function ceilToNextMinute(date: Date): Date {
  const rounded = new Date(date);
  rounded.setSeconds(0, 0);
  if (rounded.getTime() <= date.getTime()) {
    rounded.setMinutes(rounded.getMinutes() + 1);
  }
  return rounded;
}

function matchesSchedule(
  task: Pick<
    ScheduledTask,
    "dayOfWeek" | "hourOfDay" | "minuteOfHour" | "recurrence"
  >,
  parts: TimeZoneParts
): boolean {
  if (parts.minute !== task.minuteOfHour) {
    return false;
  }
  switch (task.recurrence) {
    case "hourly":
      return true;
    case "daily":
      return parts.hour === task.hourOfDay;
    case "weekly":
      return parts.hour === task.hourOfDay && parts.weekday === task.dayOfWeek;
  }
}

type TimeZoneParts = {
  hour: number;
  minute: number;
  weekday: number;
};

function getTimeZoneParts(date: Date, timeZone: string): TimeZoneParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = formatter.formatToParts(date);
  return {
    weekday: parseWeekday(
      parts.find((part) => part.type === "weekday")?.value ?? "Sun"
    ),
    hour: Number(parts.find((part) => part.type === "hour")?.value ?? "0"),
    minute: Number(parts.find((part) => part.type === "minute")?.value ?? "0"),
  };
}

function parseWeekday(value: string): number {
  switch (value) {
    case "Sun":
      return 0;
    case "Mon":
      return 1;
    case "Tue":
      return 2;
    case "Wed":
      return 3;
    case "Thu":
      return 4;
    case "Fri":
      return 5;
    case "Sat":
      return 6;
    default:
      return 0;
  }
}

function assertTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
  } catch (error) {
    if (error instanceof RangeError) {
      throw new Error(`Unsupported time zone: ${timeZone}`);
    }
    throw error;
  }
}

export const __testing = {
  applyScheduledTaskUpdate,
  buildScheduledTask,
  ceilToNextMinute,
  computeNextScheduledRun,
  getTimeZoneParts,
  getSchedulerDelayMs,
  isTaskDue,
  matchesSchedule,
  parseWeekday,
};
