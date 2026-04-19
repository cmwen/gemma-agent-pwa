import { z } from "zod";

export const GEMMA_FAST_PRESET_ID = "gemma4-fast";
export const GEMMA_BALANCED_PRESET_ID = "gemma4-balanced";
export const GEMMA_DEEP_PRESET_ID = "gemma4-deep";
export const DEFAULT_PROVIDER = "lmstudio";
export const DEFAULT_MODEL = "google/gemma-3-4b";

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

export const chatRuntimeConfigSchema = z.object({
  provider: z.literal(DEFAULT_PROVIDER).default(DEFAULT_PROVIDER),
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
  const merged: Record<string, unknown> = {};
  for (const current of configs) {
    if (!current) {
      continue;
    }
    Object.assign(merged, current);
  }
  const parsed = chatRuntimeConfigSchema.parse(merged);
  const preset = getPresetById(parsed.presetId);

  return chatRuntimeConfigSchema.parse({
    provider: DEFAULT_PROVIDER,
    model: parsed.model,
    presetId: parsed.presetId,
    lmStudioEnableThinking:
      parsed.lmStudioEnableThinking ?? preset.lmStudioEnableThinking,
    maxCompletionTokens:
      parsed.maxCompletionTokens ?? preset.maxCompletionTokens,
    contextWindowSize: parsed.contextWindowSize ?? preset.contextWindowSize,
    temperature: parsed.temperature ?? preset.temperature,
    topP: parsed.topP ?? preset.topP,
    disabledSkills: parsed.disabledSkills,
  });
}

export const agentSummarySchema = z.object({
  id: z.string().min(1),
  kind: z.literal("chat").default("chat"),
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

export const workspaceSummarySchema = z.object({
  storeRoot: z.string().min(1),
  copilotConfigDir: z.string().min(1),
  storeSkillDirectory: z.string().min(1),
  copilotSkillDirectory: z.string().min(1),
  agentCount: z.number().int().nonnegative(),
});
export type WorkspaceSummary = z.infer<typeof workspaceSummarySchema>;

export const healthStatusSchema = z.object({
  ok: z.boolean(),
  workspace: workspaceSummarySchema,
  lmStudioReachable: z.boolean(),
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
    skillName: z.string().min(1),
    skillInput: z.string(),
  }),
  z.object({
    type: z.literal("skill_result"),
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
