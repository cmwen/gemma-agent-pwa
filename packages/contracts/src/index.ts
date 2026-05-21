import { z } from "zod";

export const GEMMA_FAST_PRESET_ID = "gemma4-fast";
export const GEMMA_BALANCED_PRESET_ID = "gemma4-balanced";
export const GEMMA_DEEP_PRESET_ID = "gemma4-deep";
export const DEFAULT_PROVIDER = "lmstudio";
export const DEFAULT_MODEL = "google/gemma-3-4b";
export const CONFIGURED_PROVIDER_IDS = [DEFAULT_PROVIDER] as const;

export function normalizeProviderId(provider?: string): string | undefined {
  const trimmed = provider?.trim();
  if (!trimmed) {
    return undefined;
  }

  const normalized = trimmed.toLowerCase();
  return normalized.replace(/\s+/g, "") === DEFAULT_PROVIDER
    ? DEFAULT_PROVIDER
    : normalized;
}

export function isConfiguredProvider(provider?: string): boolean {
  return (
    (normalizeProviderId(provider) ?? DEFAULT_PROVIDER) === DEFAULT_PROVIDER
  );
}

export function requireConfiguredProvider(
  provider?: string
): typeof DEFAULT_PROVIDER {
  const normalizedProvider = normalizeProviderId(provider) ?? DEFAULT_PROVIDER;
  if (normalizedProvider !== DEFAULT_PROVIDER) {
    throw new Error(
      `Unsupported LLM provider "${normalizedProvider}". LM Studio is the only configured provider.`
    );
  }
  return DEFAULT_PROVIDER;
}

export const runtimePresetSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  lmStudioEnableThinking: z.boolean(),
  maxCompletionTokens: z.number().int().positive(),
  contextWindowSize: z.number().int().positive(),
  temperature: z.number().min(0).max(2),
  topP: z.number().min(0).max(1),
});
export type RuntimePreset = z.infer<typeof runtimePresetSchema>;

export const DEFAULT_CONTEXT_WINDOW_SIZE = 32_768;

export const GEMMA_PRESETS = runtimePresetSchema.array().parse([
  {
    id: GEMMA_FAST_PRESET_ID,
    title: "Gemma Fast",
    description:
      "Thinking off for quick drafting, follow-ups, and short answers.",
    lmStudioEnableThinking: false,
    maxCompletionTokens: 2048,
    contextWindowSize: DEFAULT_CONTEXT_WINDOW_SIZE,
    temperature: 0.2,
    topP: 0.92,
  },
  {
    id: GEMMA_BALANCED_PRESET_ID,
    title: "Gemma Balanced",
    description: "Thinking on for stronger everyday planning and analysis.",
    lmStudioEnableThinking: true,
    maxCompletionTokens: 4096,
    contextWindowSize: DEFAULT_CONTEXT_WINDOW_SIZE,
    temperature: 0.2,
    topP: 0.95,
  },
  {
    id: GEMMA_DEEP_PRESET_ID,
    title: "Gemma Deep",
    description:
      "Thinking on with a larger completion budget for harder tasks.",
    lmStudioEnableThinking: true,
    maxCompletionTokens: 8192,
    contextWindowSize: DEFAULT_CONTEXT_WINDOW_SIZE,
    temperature: 0.15,
    topP: 0.95,
  },
]);

export const skillScopeSchema = z.enum([
  "copilot-global",
  "store-global",
  "agent-local",
]);
export type SkillScope = z.infer<typeof skillScopeSchema>;

export const skillDescriptorSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  scope: skillScopeSchema,
  path: z.string().min(1),
  sourceRoot: z.string().min(1),
  hasScript: z.boolean().default(false),
  scriptPath: z.string().optional(),
});
export type SkillDescriptor = z.infer<typeof skillDescriptorSchema>;

export const chatToolSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  parameters: z.any().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type ChatTool = z.infer<typeof chatToolSchema>;

export const DELEGATION_TOOL_NAME = "delegate-task";

export function createDelegationTool(input: {
  delegatedAgentIds: string[];
  agentTitle: string;
}): ChatTool | undefined {
  if (input.delegatedAgentIds.length === 0) {
    return undefined;
  }

  const allowedAgentIds = [...new Set(input.delegatedAgentIds)];
  return chatToolSchema.parse({
    name: DELEGATION_TOOL_NAME,
    description: `Important delegation tool for ${input.agentTitle}. Use it to hand work to another agent and wait for the returned result.`,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        agentId: {
          type: "string",
          enum: allowedAgentIds,
          description: "The delegated agent to run the task.",
        },
        prompt: {
          type: "string",
          minLength: 1,
          description: "The exact work to delegate to that agent.",
        },
        title: {
          type: "string",
          description: "Optional short label for the delegated task.",
        },
      },
      required: ["agentId", "prompt"],
    },
    metadata: {
      delegatedAgentIds: allowedAgentIds,
      kind: "delegation",
    },
  });
}

export const chatRuntimeConfigSchema = z.object({
  provider: z.string().trim().min(1).default(DEFAULT_PROVIDER),
  model: z.string().min(1).default(DEFAULT_MODEL),
  presetId: z.string().min(1).default(GEMMA_BALANCED_PRESET_ID),
  lmStudioEnableThinking: z.boolean().optional(),
  maxCompletionTokens: z.number().int().positive().optional(),
  contextWindowSize: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().min(0).max(1).optional(),
  disabledSkills: z.array(z.string()).default([]),
});
export type ChatRuntimeConfig = z.infer<typeof chatRuntimeConfigSchema>;

export const partialChatRuntimeConfigSchema = chatRuntimeConfigSchema.partial();
export type PartialChatRuntimeConfig = z.infer<
  typeof partialChatRuntimeConfigSchema
>;

export function getPresetById(presetId?: string): RuntimePreset {
  const preset =
    GEMMA_PRESETS.find((preset) => preset.id === presetId) ??
    GEMMA_PRESETS[1] ??
    GEMMA_PRESETS[0];
  if (!preset) {
    throw new Error("At least one Gemma preset must be configured.");
  }
  return preset;
}

export function mergeRuntimeConfig(
  ...configs: Array<Partial<ChatRuntimeConfig> | undefined>
): ChatRuntimeConfig {
  return applyPresetRuntimeConfigDefaults(normalizeRuntimeConfig(configs));
}

export function normalizeRuntimeConfig(
  configs: Array<Partial<ChatRuntimeConfig> | undefined>
): ChatRuntimeConfig {
  const merged: Record<string, unknown> = {};
  for (const current of configs) {
    if (!current) {
      continue;
    }
    Object.assign(merged, current);
  }

  return chatRuntimeConfigSchema.parse(merged);
}

export function applyPresetRuntimeConfigDefaults(
  config: ChatRuntimeConfig
): ChatRuntimeConfig {
  const preset = getPresetById(config.presetId);

  return chatRuntimeConfigSchema.parse({
    provider: config.provider,
    model: config.model,
    presetId: config.presetId,
    lmStudioEnableThinking:
      config.lmStudioEnableThinking ?? preset.lmStudioEnableThinking,
    maxCompletionTokens:
      config.maxCompletionTokens ?? preset.maxCompletionTokens,
    contextWindowSize: config.contextWindowSize ?? preset.contextWindowSize,
    temperature: config.temperature ?? preset.temperature,
    topP: config.topP ?? preset.topP,
    disabledSkills: config.disabledSkills,
  });
}

export const agentSummarySchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["chat", "planner", "orchestrator"]).default("chat"),
  title: z.string().min(1),
  description: z.string().min(1),
  combinedPrompt: z.string().min(1),
  agentPath: z.string().min(1),
  defaultSoulPath: z.string().min(1),
  soulPath: z.string().optional(),
  historyRoot: z.string().min(1),
  workingMemoryRoot: z.string().min(1),
  skillRoot: z.string().min(1),
  skillNames: z.array(z.string()),
  delegatedAgentIds: z.array(z.string()).optional(),
  sessionCount: z.number().int().nonnegative(),
  runtimeConfig: chatRuntimeConfigSchema.optional(),
});
export type AgentSummary = z.infer<typeof agentSummarySchema>;

export const senderSchema = z.enum(["user", "assistant", "system", "tool"]);
export type TurnSender = z.infer<typeof senderSchema>;

export const attachmentMediaTypeSchema = z.enum(["image", "text", "binary"]);
export type AttachmentMediaType = z.infer<typeof attachmentMediaTypeSchema>;

export const attachmentUploadSchema = z.object({
  name: z.string().trim().min(1),
  contentType: z.string().trim().min(1),
  size: z.number().int().nonnegative(),
  base64Data: z.string().min(1),
});
export type AttachmentUpload = z.infer<typeof attachmentUploadSchema>;

export const sessionListStateSchema = z.enum(["active", "deleted", "all"]);
export type SessionListState = z.infer<typeof sessionListStateSchema>;

export const sessionDeleteModeSchema = z.enum(["soft", "permanent"]);
export type SessionDeleteMode = z.infer<typeof sessionDeleteModeSchema>;

export const storedAttachmentSchema = z.object({
  attachmentId: z.string().min(1),
  name: z.string().min(1),
  contentType: z.string().min(1),
  size: z.number().int().nonnegative(),
  mediaType: attachmentMediaTypeSchema,
  relativePath: z.string().min(1),
});
export type StoredAttachment = z.infer<typeof storedAttachmentSchema>;

export const llmRequestStatsSchema = z.object({
  recordedAt: z.string().min(1),
  model: z.string().min(1),
  requestCount: z.number().int().positive().default(1),
  inputTokens: z.number().int().nonnegative().default(0),
  outputTokens: z.number().int().nonnegative().default(0),
  durationMs: z.number().nonnegative().default(0),
  tokensPerSecond: z.number().nonnegative().optional(),
});
export type LlmRequestStats = z.infer<typeof llmRequestStatsSchema>;

export const llmSessionStatsSchema = z.object({
  requestCount: z.number().int().nonnegative().default(0),
  inputTokens: z.number().int().nonnegative().default(0),
  outputTokens: z.number().int().nonnegative().default(0),
  totalDurationMs: z.number().nonnegative().default(0),
  lastRecordedAt: z.string().min(1).optional(),
  lastModel: z.string().min(1).optional(),
  lastTokensPerSecond: z.number().nonnegative().optional(),
});
export type LlmSessionStats = z.infer<typeof llmSessionStatsSchema>;

function clampNonNegativeMetric(value: unknown): unknown {
  return typeof value === "number" ? Math.max(0, value) : value;
}

export function normalizeLlmRequestStats(value: unknown): LlmRequestStats {
  if (!value || typeof value !== "object") {
    return llmRequestStatsSchema.parse(value);
  }

  const candidate = value as Record<string, unknown>;
  return llmRequestStatsSchema.parse({
    ...candidate,
    durationMs: clampNonNegativeMetric(candidate.durationMs),
    tokensPerSecond: clampNonNegativeMetric(candidate.tokensPerSecond),
  });
}

export function normalizeLlmSessionStats(value: unknown): LlmSessionStats {
  if (!value || typeof value !== "object") {
    return llmSessionStatsSchema.parse(value);
  }

  const candidate = value as Record<string, unknown>;
  return llmSessionStatsSchema.parse({
    ...candidate,
    totalDurationMs: clampNonNegativeMetric(candidate.totalDurationMs),
    lastTokensPerSecond: clampNonNegativeMetric(candidate.lastTokensPerSecond),
  });
}

export const scheduledTaskRecurrenceSchema = z.enum([
  "hourly",
  "daily",
  "weekly",
]);
export type ScheduledTaskRecurrence = z.infer<
  typeof scheduledTaskRecurrenceSchema
>;

export const scheduledTaskSessionModeSchema = z.enum(["dedicated", "fresh"]);
export type ScheduledTaskSessionMode = z.infer<
  typeof scheduledTaskSessionModeSchema
>;

export const scheduledTaskRunStatusSchema = z.enum([
  "running",
  "success",
  "error",
]);
export type ScheduledTaskRunStatus = z.infer<
  typeof scheduledTaskRunStatusSchema
>;

export const scheduledTaskRunTriggerSchema = z.enum([
  "schedule",
  "manual",
  "catch-up",
]);
export type ScheduledTaskRunTrigger = z.infer<
  typeof scheduledTaskRunTriggerSchema
>;

export const scheduledTaskRunSchema = z.object({
  runId: z.string().min(1),
  status: scheduledTaskRunStatusSchema,
  trigger: scheduledTaskRunTriggerSchema,
  scheduledFor: z.string().min(1),
  startedAt: z.string().min(1),
  completedAt: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  assistantSummary: z.string().min(1).optional(),
  errorMessage: z.string().min(1).optional(),
});
export type ScheduledTaskRun = z.infer<typeof scheduledTaskRunSchema>;

const scheduledTaskBaseSchema = z.object({
  agentId: z.string().min(1),
  title: z.string().trim().min(1).max(100),
  prompt: z.string().trim().min(1).max(8_000),
  recurrence: scheduledTaskRecurrenceSchema,
  minuteOfHour: z.number().int().min(0).max(59),
  hourOfDay: z.number().int().min(0).max(23).optional(),
  dayOfWeek: z.number().int().min(0).max(6).optional(),
  timezone: z.string().trim().min(1),
  enabled: z.boolean().default(true),
  notifyOnCompletion: z.boolean().default(true),
  sessionMode: scheduledTaskSessionModeSchema.default("dedicated"),
});

export const scheduledTaskSchema = scheduledTaskBaseSchema
  .extend({
    id: z.string().min(1),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
    nextRunAt: z.string().min(1),
    lastRunAt: z.string().min(1).optional(),
    lastRunStatus: scheduledTaskRunStatusSchema.optional(),
    lastRunError: z.string().min(1).optional(),
    lastSessionId: z.string().min(1).optional(),
    lastAssistantSummary: z.string().min(1).optional(),
    runningAt: z.string().min(1).optional(),
    recentRuns: z.array(scheduledTaskRunSchema).default([]),
  })
  .superRefine((task, context) => {
    if (task.recurrence !== "hourly" && task.hourOfDay === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Daily and weekly schedules require an hour of day.",
        path: ["hourOfDay"],
      });
    }
    if (task.recurrence !== "weekly" && task.dayOfWeek !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Only weekly schedules can set a day of week.",
        path: ["dayOfWeek"],
      });
    }
    if (task.recurrence === "weekly" && task.dayOfWeek === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Weekly schedules require a day of week.",
        path: ["dayOfWeek"],
      });
    }
  });
export type ScheduledTask = z.infer<typeof scheduledTaskSchema>;

export const scheduledTaskCreateSchema = scheduledTaskBaseSchema.superRefine(
  (task, context) => {
    if (task.recurrence !== "hourly" && task.hourOfDay === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Daily and weekly schedules require an hour of day.",
        path: ["hourOfDay"],
      });
    }
    if (task.recurrence !== "weekly" && task.dayOfWeek !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Only weekly schedules can set a day of week.",
        path: ["dayOfWeek"],
      });
    }
    if (task.recurrence === "weekly" && task.dayOfWeek === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Weekly schedules require a day of week.",
        path: ["dayOfWeek"],
      });
    }
  }
);
export type ScheduledTaskCreate = z.infer<typeof scheduledTaskCreateSchema>;

export const scheduledTaskUpdateSchema = scheduledTaskBaseSchema.partial();
export type ScheduledTaskUpdate = z.infer<typeof scheduledTaskUpdateSchema>;

export const plannerTaskStatusSchema = z.enum([
  "pending",
  "running",
  "success",
  "error",
]);
export type PlannerTaskStatus = z.infer<typeof plannerTaskStatusSchema>;

export const plannerRunStatusSchema = z.enum([
  "pending",
  "running",
  "success",
  "error",
]);
export type PlannerRunStatus = z.infer<typeof plannerRunStatusSchema>;

export const plannerTaskSchema = z.object({
  id: z.string().min(1),
  title: z.string().trim().min(1).max(160),
  taskerAgentId: z.string().min(1),
  prompt: z.string().trim().min(1).max(8_000),
  status: plannerTaskStatusSchema,
  attemptCount: z.number().int().nonnegative().default(0),
  startedAt: z.string().min(1).optional(),
  completedAt: z.string().min(1).optional(),
  lastError: z.string().min(1).optional(),
  resultSessionId: z.string().min(1).optional(),
  resultSummary: z.string().min(1).optional(),
});
export type PlannerTask = z.infer<typeof plannerTaskSchema>;

export const plannerRunSchema = z.object({
  runId: z.string().min(1),
  plannerAgentId: z.string().min(1),
  title: z.string().trim().min(1).max(160),
  objective: z.string().trim().min(1).max(8_000),
  status: plannerRunStatusSchema,
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  startedAt: z.string().min(1).optional(),
  completedAt: z.string().min(1).optional(),
  lastError: z.string().min(1).optional(),
  tasks: z.array(plannerTaskSchema).min(1),
});
export type PlannerRun = z.infer<typeof plannerRunSchema>;

export const plannerTaskCreateSchema = z.object({
  id: z.string().min(1).optional(),
  title: z.string().trim().min(1).max(160),
  taskerAgentId: z.string().min(1),
  prompt: z.string().trim().min(1).max(8_000),
});
export type PlannerTaskCreate = z.infer<typeof plannerTaskCreateSchema>;

export const plannerRunCreateSchema = z.object({
  plannerAgentId: z.string().min(1),
  title: z.string().trim().min(1).max(160).optional(),
  objective: z.string().trim().min(1).max(8_000),
  tasks: z.array(plannerTaskCreateSchema).min(1),
});
export type PlannerRunCreate = z.infer<typeof plannerRunCreateSchema>;

export const chatTurnSchema = z.object({
  messageId: z.string().min(1),
  sender: senderSchema,
  createdAt: z.string().min(1),
  bodyMarkdown: z.string(),
  thinkingMarkdown: z.string().optional(),
  relativePath: z.string().min(1),
  attachment: storedAttachmentSchema.optional(),
});
export type ChatTurn = z.infer<typeof chatTurnSchema>;

export const chatSessionSummarySchema = z.object({
  sessionId: z.string().min(1),
  agentId: z.string().min(1),
  title: z.string().min(1),
  startedAt: z.string().min(1),
  summary: z.string(),
  manifestPath: z.string().min(1),
  turnCount: z.number().int().nonnegative(),
  lastTurnAt: z.string().optional(),
  deletedAt: z.string().optional(),
  runtimeConfig: chatRuntimeConfigSchema.optional(),
  llmStats: llmSessionStatsSchema.optional(),
});
export type ChatSessionSummary = z.infer<typeof chatSessionSummarySchema>;

export const chatSessionSchema = chatSessionSummarySchema.extend({
  turns: z.array(chatTurnSchema),
});
export type ChatSession = z.infer<typeof chatSessionSchema>;

export const modelDescriptorSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  provider: z.string().min(1).default("LM Studio"),
  isGemma: z.boolean().default(false),
});
export type ModelDescriptor = z.infer<typeof modelDescriptorSchema>;

export const speechAudioFormatSchema = z.enum(["mp3", "wav", "flac", "pcm"]);
export type SpeechAudioFormat = z.infer<typeof speechAudioFormatSchema>;

export const transcriptionResponseFormatSchema = z.enum([
  "text",
  "json",
  "verbose_json",
  "srt",
  "vtt",
]);
export type TranscriptionResponseFormat = z.infer<
  typeof transcriptionResponseFormatSchema
>;

export const speechHealthSchema = z.object({
  ok: z.boolean(),
  provider: z.literal("openai-compatible"),
  upstreamOk: z.boolean(),
  upstreamBaseUrl: z.string().url(),
  sttModel: z.string().min(1),
  ttsModel: z.string().min(1),
  defaultVoice: z.string().min(1),
  nlpModel: z.string().min(1).optional(),
  nlpUpstreamOk: z.boolean().optional(),
  nlpUpstreamBaseUrl: z.string().url().optional(),
  detail: z.string().optional(),
});
export type SpeechHealth = z.infer<typeof speechHealthSchema>;

export const speechCapabilitiesSchema = z.object({
  provider: z.literal("openai-compatible"),
  upstreamBaseUrl: z.string().url(),
  transcription: z.object({
    endpoint: z.literal("/v1/audio/transcriptions"),
    model: z.string().min(1),
    responseFormats: z.array(transcriptionResponseFormatSchema),
  }),
  synthesis: z.object({
    endpoint: z.literal("/v1/audio/speech"),
    model: z.string().min(1),
    defaultVoice: z.string().min(1),
    responseFormats: z.array(speechAudioFormatSchema),
  }),
  realtime: z.object({
    supported: z.boolean(),
    upstreamEndpoint: z.string().optional(),
  }),
  textProcessing: z
    .object({
      endpoint: z.enum(["/v1/npl", "/v1/text/process"]),
      model: z.string().min(1),
      targetLanguage: z.string().min(1),
      features: z.array(z.string().min(1)),
    })
    .optional(),
});
export type SpeechCapabilities = z.infer<typeof speechCapabilitiesSchema>;

export const speechSynthesisRequestSchema = z.object({
  input: z.string().trim().min(1),
  voice: z.string().trim().min(1).optional(),
  model: z.string().trim().min(1).optional(),
  responseFormat: speechAudioFormatSchema.optional(),
  speed: z.number().min(0.25).max(4).optional(),
});
export type SpeechSynthesisRequest = z.infer<
  typeof speechSynthesisRequestSchema
>;

export const transcriptionOptionsSchema = z.object({
  language: z.string().trim().min(2).max(16).optional(),
  prompt: z.string().trim().min(1).max(500).optional(),
  model: z.string().trim().min(1).optional(),
  temperature: z.number().min(0).max(1).optional(),
  responseFormat: transcriptionResponseFormatSchema.optional(),
});
export type TranscriptionOptions = z.infer<typeof transcriptionOptionsSchema>;

export const transcriptionResultSchema = z.object({
  text: z.string(),
  model: z.string().min(1),
  provider: z.literal("openai-compatible"),
  raw: z.unknown(),
});
export type TranscriptionResult = z.infer<typeof transcriptionResultSchema>;

export const textProcessingRequestSchema = z.object({
  input: z.string().trim().min(1),
  language: z.string().trim().min(2).max(16).optional(),
  targetLanguage: z.string().trim().min(2).max(16).optional(),
});
export type TextProcessingRequest = z.infer<typeof textProcessingRequestSchema>;

export const textProcessingResultSchema = z.object({
  sourceText: z.string(),
  detectedLanguage: z.string().min(1),
  intent: z.string().min(1),
  cleanedText: z.string().min(1),
  rewrittenText: z.string().min(1),
  translatedText: z.string().min(1),
  targetLanguage: z.string().min(1),
  fillerWords: z.array(z.string()),
  model: z.string().min(1),
  provider: z.literal("openai-compatible"),
  raw: z.unknown(),
});
export type TextProcessingResult = z.infer<typeof textProcessingResultSchema>;

export const workspaceSummarySchema = z.object({
  id: z.string().min(1),
  storeRoot: z.string().min(1),
  copilotConfigDir: z.string().min(1),
  storeSkillDirectory: z.string().min(1),
  copilotSkillDirectory: z.string().min(1),
  agentCount: z.number().int().nonnegative(),
});
export type WorkspaceSummary = z.infer<typeof workspaceSummarySchema>;

export const workspaceListingSchema = z.object({
  workspaces: z.array(workspaceSummarySchema),
  defaultId: z.string().min(1),
});
export type WorkspaceListing = z.infer<typeof workspaceListingSchema>;

export const healthStatusSchema = z.object({
  ok: z.boolean(),
  workspace: workspaceSummarySchema,
  lmStudioReachable: z.boolean(),
  speechReachable: z.boolean().default(false),
  speech: speechHealthSchema.optional(),
  speechIssue: z.string().min(1).optional(),
  defaultModel: z.string().min(1).optional(),
  warmedModel: z.string().min(1).optional(),
  modelCount: z.number().int().nonnegative(),
  message: z.string().min(1),
});
export type HealthStatus = z.infer<typeof healthStatusSchema>;

export const chatRequestSchema = z.object({
  sessionId: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  prompt: z.string().min(1),
  config: partialChatRuntimeConfigSchema.optional(),
  scheduledTaskId: z.string().min(1).optional(),
  tools: z.array(chatToolSchema).optional(),
});
export type ChatRequest = z.infer<typeof chatRequestSchema>;

export const chatResponseSchema = z.object({
  thread: chatSessionSchema,
  assistantTurn: chatTurnSchema,
});
export type ChatResponse = z.infer<typeof chatResponseSchema>;

export const chatStreamEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("thread"),
    thread: chatSessionSchema,
  }),
  z.object({
    type: z.literal("assistant_snapshot"),
    assistantText: z.string().optional(),
    thinkingText: z.string().optional(),
  }),
  z.object({
    type: z.literal("skill_call"),
    skillCallId: z.string().min(1).optional(),
    skillName: z.string().min(1),
    skillInput: z.string(),
  }),
  z.object({
    type: z.literal("skill_result"),
    skillCallId: z.string().min(1).optional(),
    skillName: z.string().min(1),
    skillOutput: z.string(),
    exitCode: z.number().int(),
  }),
  z.object({
    type: z.literal("complete"),
    response: chatResponseSchema,
  }),
  z.object({
    type: z.literal("error"),
    error: z.string().min(1),
  }),
]);
export type ChatStreamEvent = z.infer<typeof chatStreamEventSchema>;
