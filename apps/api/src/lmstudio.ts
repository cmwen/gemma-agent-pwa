import os from "node:os";
import type {
  ChatRuntimeConfig,
  ChatTurn,
  LlmRequestStats,
  ModelDescriptor,
} from "@gemma-agent-pwa/contracts";
import type { LoadedSkillDocument } from "@gemma-agent-pwa/min-kb-bridge";

const DEFAULT_BASE_URL = "http://127.0.0.1:1234/v1";
const DEFAULT_LOCALHOST_BASE_URL = "http://localhost:1234/v1";
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS = 10_000;
const THINKING_BLOCK_PATTERNS = [
  /^\s*<think>\s*([\s\S]*?)\s*<\/think>\s*/i,
  /^\s*<thinking>\s*([\s\S]*?)\s*<\/thinking>\s*/i,
  /^\s*<reasoning>\s*([\s\S]*?)\s*<\/reasoning>\s*/i,
];
let preferredBaseUrl: string | undefined;

interface LmStudioChatCompletionResponse {
  id?: string;
  created?: number;
  model?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
  choices?: Array<{
    delta?: {
      reasoning?: string | LmStudioContentPart[];
      reasoning_content?: string | LmStudioContentPart[];
      content?: string | LmStudioContentPart[];
    };
    message?: {
      reasoning?: string | LmStudioContentPart[];
      reasoning_content?: string | LmStudioContentPart[];
      content?: string | LmStudioContentPart[];
    };
    finish_reason?: string | null;
  }>;
}

interface LmStudioContentPart {
  type?: string;
  text?: string;
  thinking?: string;
}

interface StreamSnapshot {
  assistantText?: string;
  thinkingText?: string;
}

export interface StreamLmStudioChatInput {
  model: string;
  config: ChatRuntimeConfig;
  conversation: ChatTurn[];
  agentPrompt?: string;
  enabledSkills: LoadedSkillDocument[];
  onSnapshot: (snapshot: StreamSnapshot) => void;
}

export interface StreamLmStudioChatResult {
  assistantText: string;
  thinkingText?: string;
  llmStats: LlmRequestStats;
}

export interface LmStudioModelCatalog {
  models: ModelDescriptor[];
  reachable: boolean;
}

export async function listLmStudioModels(): Promise<ModelDescriptor[]> {
  return (await getLmStudioModelCatalog()).models;
}

export async function getLmStudioModelCatalog(): Promise<LmStudioModelCatalog> {
  try {
    const response = await fetchLmStudio(
      "/models",
      undefined,
      DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS,
      "LM Studio model discovery"
    );
    if (!response.ok) {
      throw new Error(
        `LM Studio returned ${response.status} while listing models.`
      );
    }
    const payload = (await response.json()) as {
      data?: Array<{ id?: string; owned_by?: string }>;
    };
    return (payload.data ?? [])
      .filter((item): item is { id: string; owned_by?: string } =>
        Boolean(item.id)
      )
      .map((item) => ({
        id: item.id,
        displayName: item.id,
        provider: item.owned_by ?? "LM Studio",
        isGemma: /gemma/i.test(item.id),
      }))
      .reduce<LmStudioModelCatalog>(
        (catalog, model) => {
          catalog.models.push(model);
          return catalog;
        },
        { models: [], reachable: true }
      );
  } catch {
    return {
      models: getConfiguredModelDescriptors(),
      reachable: false,
    };
  }
}

export async function streamLmStudioChat(
  input: StreamLmStudioChatInput
): Promise<StreamLmStudioChatResult> {
  const startedAt = Date.now();
  const requestBody = {
    model: input.model,
    messages: buildMessages(
      input.conversation,
      input.agentPrompt,
      input.enabledSkills
    ),
    max_completion_tokens: input.config.maxCompletionTokens,
    temperature: input.config.temperature,
    top_p: input.config.topP,
    stream: true,
    ...(input.config.lmStudioEnableThinking === undefined
      ? {}
      : { enable_thinking: input.config.lmStudioEnableThinking }),
  };
  const response = await sendStreamingRequest(input.model, requestBody);
  const completion = await readChatCompletionStream(response, input.onSnapshot);
  const sections = extractMessageSections(completion);
  if (!sections.assistantText) {
    throw new Error("LM Studio returned no assistant message content.");
  }

  const durationMs = Date.now() - startedAt;
  const outputTokens = completion.usage?.completion_tokens ?? 0;
  return {
    assistantText: sections.assistantText,
    ...(sections.thinkingText ? { thinkingText: sections.thinkingText } : {}),
    llmStats: {
      recordedAt: new Date().toISOString(),
      model: input.model,
      requestCount: 1,
      inputTokens: completion.usage?.prompt_tokens ?? 0,
      outputTokens,
      durationMs,
      ...(outputTokens > 0 && durationMs > 0
        ? {
            tokensPerSecond: Number(
              ((outputTokens / durationMs) * 1000).toFixed(2)
            ),
          }
        : {}),
    },
  };
}

async function sendStreamingRequest(
  model: string,
  body: Record<string, unknown>
): Promise<Response> {
  const attempt = () =>
    fetchLmStudio(
      "/chat/completions",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      },
      DEFAULT_TIMEOUT_MS,
      "LM Studio chat stream request"
    );
  let response = await attempt();
  if (response.ok) {
    return response;
  }

  const failureBody = await response.text();
  if (!shouldRetryAfterModelLoad(response.status, failureBody)) {
    throw new Error(formatChatError(response.status, failureBody));
  }

  await loadModel(model);
  response = await attempt();
  if (!response.ok) {
    throw new Error(formatChatError(response.status, await response.text()));
  }
  return response;
}

function buildMessages(
  conversation: ChatTurn[],
  agentPrompt: string | undefined,
  enabledSkills: LoadedSkillDocument[]
): Array<{ role: "system" | "user" | "assistant"; content: string }> {
  const systemPrompt = buildSystemPrompt(agentPrompt, enabledSkills);
  const history = conversation
    .filter((turn) => turn.bodyMarkdown.trim().length > 0)
    .map((turn) => ({
      role: mapTurnRole(turn.sender),
      content: turn.bodyMarkdown.trim(),
    }));
  return systemPrompt
    ? [{ role: "system", content: systemPrompt }, ...history]
    : history;
}

function buildSystemPrompt(
  agentPrompt: string | undefined,
  enabledSkills: LoadedSkillDocument[]
): string | undefined {
  const sections = [
    "You are running through LM Studio inside Gemma Agent PWA.",
    "Stay grounded in the current conversation and the provided agent instructions.",
    "Do not imply tool execution, MCP access, or external system results unless they already appear in the conversation.",
    agentPrompt?.trim()
      ? `## Agent instructions\n\n${agentPrompt.trim()}`
      : undefined,
    enabledSkills.length > 0
      ? [
          "## Enabled skills",
          ...enabledSkills.map(
            (skill) =>
              `### ${skill.name}\n- Scope: ${skill.scope}\n- Description: ${skill.description}\n\n${skill.content.trim()}`
          ),
        ].join("\n\n")
      : undefined,
  ].filter((section): section is string => Boolean(section?.trim()));
  return sections.length > 0 ? sections.join("\n\n") : undefined;
}

function mapTurnRole(
  sender: ChatTurn["sender"]
): "system" | "user" | "assistant" {
  switch (sender) {
    case "assistant":
    case "tool":
      return "assistant";
    case "system":
      return "system";
    default:
      return "user";
  }
}

async function readChatCompletionStream(
  response: Response,
  onSnapshot: (snapshot: StreamSnapshot) => void
): Promise<LmStudioChatCompletionResponse> {
  if (!response.body) {
    throw new Error("LM Studio returned no response body for chat streaming.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const completion: LmStudioChatCompletionResponse = {};
  const accumulator = new StreamAccumulator();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });

    let boundaryIndex = buffer.indexOf("\n\n");
    while (boundaryIndex >= 0) {
      const block = buffer.slice(0, boundaryIndex);
      buffer = buffer.slice(boundaryIndex + 2);
      const chunk = parseStreamChunk(block);
      if (chunk && chunk !== "[DONE]") {
        mergeCompletionChunk(completion, chunk);
        const snapshot = accumulator.consumeChunk(chunk);
        if (snapshot) {
          onSnapshot(snapshot);
        }
      }
      boundaryIndex = buffer.indexOf("\n\n");
    }

    if (done) {
      const trailing = parseStreamChunk(buffer.trim());
      if (trailing && trailing !== "[DONE]") {
        mergeCompletionChunk(completion, trailing);
        const snapshot = accumulator.consumeChunk(trailing);
        if (snapshot) {
          onSnapshot(snapshot);
        }
      }
      break;
    }
  }

  const finalSnapshot = combineSections([
    extractMessageSections(completion),
    accumulator.getSnapshot(),
  ]);
  if (finalSnapshot.assistantText || finalSnapshot.thinkingText) {
    completion.choices = [
      {
        ...completion.choices?.[0],
        message: {
          ...(finalSnapshot.assistantText
            ? { content: finalSnapshot.assistantText }
            : {}),
          ...(finalSnapshot.thinkingText
            ? { reasoning: `<think>${finalSnapshot.thinkingText}</think>` }
            : {}),
        },
      },
    ];
  }
  return completion;
}

function parseStreamChunk(
  block: string
): LmStudioChatCompletionResponse | "[DONE]" | undefined {
  const data = block
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("\n");
  if (!data) {
    return undefined;
  }
  if (data === "[DONE]") {
    return "[DONE]";
  }
  return JSON.parse(data) as LmStudioChatCompletionResponse;
}

function mergeCompletionChunk(
  target: LmStudioChatCompletionResponse,
  chunk: LmStudioChatCompletionResponse
): void {
  target.id = chunk.id ?? target.id;
  target.created = chunk.created ?? target.created;
  target.model = chunk.model ?? target.model;
  target.usage = chunk.usage ?? target.usage;
  const nextChoice = chunk.choices?.[0];
  if (!nextChoice) {
    return;
  }
  const previousChoice = target.choices?.[0];
  target.choices = [
    {
      ...previousChoice,
      ...nextChoice,
      message: nextChoice.message ?? previousChoice?.message,
      finish_reason: nextChoice.finish_reason ?? previousChoice?.finish_reason,
    },
  ];
}

function extractMessageSections(
  completion: LmStudioChatCompletionResponse
): StreamSnapshot {
  const message = completion.choices?.[0]?.message;
  if (!message) {
    return {};
  }

  return combineSections([
    extractPayloadSections(message.content),
    extractPayloadSections(message.reasoning_content),
    extractPayloadSections(message.reasoning),
  ]);
}

function extractPayloadSections(
  payload: string | LmStudioContentPart[] | undefined
): StreamSnapshot {
  const split = splitLeadingThinkingBlocks(extractRawPayload(payload));
  const thinkingText = combineTextCandidates(split.thinkingBlocks);
  return {
    ...(split.remainingContent
      ? { assistantText: split.remainingContent }
      : {}),
    ...(thinkingText ? { thinkingText } : {}),
  };
}

function extractRawPayload(
  payload: string | LmStudioContentPart[] | undefined
): string {
  if (typeof payload === "string") {
    return payload;
  }
  if (!Array.isArray(payload)) {
    return "";
  }

  return payload
    .map((part) => {
      const normalizedType = part.type?.trim().toLowerCase();
      if (normalizedType === "thinking" || normalizedType === "reasoning") {
        const thinkingText = (part.thinking ?? part.text ?? "").trim();
        return thinkingText ? `<think>${thinkingText}</think>` : "";
      }
      return part.text ?? "";
    })
    .join("");
}

function splitLeadingThinkingBlocks(content: string): {
  thinkingBlocks: string[];
  remainingContent: string;
} {
  const thinkingBlocks: string[] = [];
  let remainingContent = content;

  while (true) {
    const pattern = THINKING_BLOCK_PATTERNS.find((candidate) =>
      candidate.test(remainingContent)
    );
    if (!pattern) {
      break;
    }
    const match = remainingContent.match(pattern);
    if (!match) {
      break;
    }
    const thinkingText = match[1]?.trim();
    if (thinkingText) {
      thinkingBlocks.push(thinkingText);
    }
    remainingContent = remainingContent.slice(match[0].length);
  }

  return {
    thinkingBlocks,
    remainingContent: remainingContent.trim(),
  };
}

function combineSections(sections: StreamSnapshot[]): StreamSnapshot {
  const assistantText = combineTextCandidates(
    sections.map((section) => section.assistantText)
  );
  const thinkingText = combineTextCandidates(
    sections.map((section) => section.thinkingText)
  );
  return {
    ...(assistantText ? { assistantText } : {}),
    ...(thinkingText ? { thinkingText } : {}),
  };
}

function combineTextCandidates(
  candidates: Array<string | undefined>
): string | undefined {
  const normalized = candidates
    .map((candidate) => candidate?.trim())
    .filter((candidate): candidate is string => Boolean(candidate));
  if (normalized.length === 0) {
    return undefined;
  }

  const deduped: string[] = [];
  for (const candidate of normalized) {
    const existingIndex = deduped.findIndex(
      (value) => value === candidate || candidate.includes(value)
    );
    if (existingIndex >= 0) {
      deduped[existingIndex] = candidate;
      continue;
    }
    if (deduped.some((value) => value.includes(candidate))) {
      continue;
    }
    deduped.push(candidate);
  }
  return deduped.join("\n\n") || undefined;
}

class StreamAccumulator {
  private assistantText: string | undefined;
  private thinkingText: string | undefined;

  consumeChunk(
    chunk: LmStudioChatCompletionResponse
  ): StreamSnapshot | undefined {
    const delta = chunk.choices?.[0]?.delta;
    if (!delta) {
      return undefined;
    }
    const nextSnapshot = combineSections([
      extractPayloadSections(delta.content),
      extractPayloadSections(delta.reasoning_content),
      extractPayloadSections(delta.reasoning),
    ]);
    if (!nextSnapshot.assistantText && !nextSnapshot.thinkingText) {
      return undefined;
    }

    this.assistantText = combineTextCandidates([
      this.assistantText,
      nextSnapshot.assistantText,
    ]);
    this.thinkingText = combineTextCandidates([
      this.thinkingText,
      nextSnapshot.thinkingText,
    ]);
    return this.getSnapshot();
  }

  getSnapshot(): StreamSnapshot {
    return {
      ...(this.assistantText ? { assistantText: this.assistantText } : {}),
      ...(this.thinkingText ? { thinkingText: this.thinkingText } : {}),
    };
  }
}

async function loadModel(model: string): Promise<void> {
  const response = await fetchLmStudioNative(
    "/api/v1/models/load",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ model }),
    },
    DEFAULT_TIMEOUT_MS,
    "LM Studio model load request"
  );
  if (response.ok) {
    return;
  }
  throw new Error(
    `LM Studio failed to auto-load model "${model}" (${response.status}): ${await response.text()}`
  );
}

function shouldRetryAfterModelLoad(status: number, body: string): boolean {
  if (status < 400 || status >= 500) {
    return false;
  }
  return /not loaded|load the model|unknown model|failed to load/i.test(body);
}

function formatChatError(status: number, body: string): string {
  return `LM Studio chat request failed (${status}): ${body.trim() || "Unknown error."}`;
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/$/, "");
}

async function fetchLmStudio(
  pathname: string,
  init: RequestInit | undefined,
  timeoutMs: number,
  label: string
): Promise<Response> {
  return fetchLmStudioAcrossCandidates(
    getBaseUrlCandidates(),
    pathname,
    init,
    timeoutMs,
    label
  );
}

async function fetchLmStudioNative(
  pathname: string,
  init: RequestInit | undefined,
  timeoutMs: number,
  label: string
): Promise<Response> {
  return fetchLmStudioAcrossCandidates(
    getBaseUrlCandidates().map(toNativeBaseUrl),
    pathname,
    init,
    timeoutMs,
    label
  );
}

async function fetchLmStudioAcrossCandidates(
  baseUrls: string[],
  pathname: string,
  init: RequestInit | undefined,
  timeoutMs: number,
  label: string
): Promise<Response> {
  let lastError: unknown;
  for (const baseUrl of baseUrls) {
    try {
      const response = await fetchWithTimeout(
        `${baseUrl}${pathname}`,
        init,
        timeoutMs,
        label
      );
      preferredBaseUrl = toApiBaseUrl(baseUrl);
      return response;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`${label} failed before reaching LM Studio.`);
}

function getBaseUrlCandidates(): string[] {
  const explicitBaseUrl =
    process.env.GEMMA_AGENT_PWA_LM_STUDIO_BASE_URL ??
    process.env.MIN_KB_APP_LM_STUDIO_BASE_URL ??
    process.env.LM_STUDIO_BASE_URL;
  if (explicitBaseUrl) {
    return [normalizeBaseUrl(explicitBaseUrl)];
  }

  const hostname = os.hostname().trim().toLowerCase();
  return dedupeUrls([
    preferredBaseUrl,
    DEFAULT_BASE_URL,
    DEFAULT_LOCALHOST_BASE_URL,
    hostname &&
    hostname !== "localhost" &&
    hostname !== "127.0.0.1" &&
    hostname !== "::1"
      ? `http://${hostname}:1234/v1`
      : undefined,
  ]);
}

function toNativeBaseUrl(value: string): string {
  const url = new URL(value);
  url.pathname = "";
  return url.toString().replace(/\/$/, "");
}

function toApiBaseUrl(value: string): string {
  return value.endsWith("/v1") ? value : `${value}/v1`;
}

function dedupeUrls(values: Array<string | undefined>): string[] {
  const deduped: string[] = [];
  for (const value of values) {
    const normalizedValue = value ? normalizeBaseUrl(value) : undefined;
    if (!normalizedValue || deduped.includes(normalizedValue)) {
      continue;
    }
    deduped.push(normalizedValue);
  }
  return deduped;
}

function getConfiguredModelDescriptors(): ModelDescriptor[] {
  const configuredModel =
    process.env.LM_STUDIO_MODEL ?? process.env.MIN_KB_APP_LM_STUDIO_MODEL;
  return configuredModel
    ? [
        {
          id: configuredModel,
          displayName: configuredModel,
          provider: "LM Studio",
          isGemma: /gemma/i.test(configuredModel),
        },
      ]
    : [];
}

async function fetchWithTimeout(
  input: string,
  init: RequestInit | undefined,
  timeoutMs: number,
  label: string
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`${label} timed out after ${timeoutMs}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

export const __testing = {
  combineTextCandidates,
  dedupeUrls,
  extractPayloadSections,
  getBaseUrlCandidates,
  splitLeadingThinkingBlocks,
  toApiBaseUrl,
  toNativeBaseUrl,
};
