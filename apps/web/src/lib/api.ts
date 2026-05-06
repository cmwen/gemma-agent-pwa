import {
  type AgentSubscriber,
  type CustomEvent,
  HttpAgent,
  type Message,
} from "@ag-ui/client";
import type {
  AgentSummary,
  ChatRequest,
  ChatSession,
  ChatSessionSummary,
  ChatStreamEvent,
  ChatTurn,
  HealthStatus,
  ModelDescriptor,
  ScheduledTask,
  ScheduledTaskCreate,
  ScheduledTaskUpdate,
  SessionDeleteMode,
  SessionListState,
  SpeechCapabilities,
  SpeechSynthesisRequest,
  TranscriptionOptions,
  TranscriptionResult,
} from "@gemma-agent-pwa/contracts";

const API_ROOT = import.meta.env.VITE_API_BASE_URL ?? "/api";
const GEMMA_SKILL_RESULT_EVENT = "gemma-skill-result";
const SNAPSHOT_FLUSH_INTERVAL_MS = 125;

interface StreamChatCallbacks {
  signal?: AbortSignal;
  thread?: ChatSession;
  onEvent: (event: ChatStreamEvent) => void;
}

interface GemmaSkillResultMeta {
  exitCode: number;
  toolCallId: string;
}

interface PendingToolCall {
  exitCode?: number;
  skillInput: string;
  skillName: string;
  toolCallId: string;
}

const COMPLETE_SKILL_CALL_BLOCKS = [
  /<skill_call\s+name="[^"]+">[\s\S]*?<\/skill_call>/g,
  /<\|tool_call>\s*call(?:\s*:\s*|\s+)[A-Za-z0-9_.-]+[\s\S]*?(?:<\|tool_call\|>|<tool_call\|>|<\/tool_call>)/g,
];
const PARTIAL_SKILL_CALL_MARKERS = [
  "<skill_call",
  "<|tool_call>",
  "<tool_call",
];

export async function getHealth(): Promise<HealthStatus> {
  return fetchJson<HealthStatus>(`${API_ROOT}/health`);
}

export async function getModels(): Promise<ModelDescriptor[]> {
  return fetchJson<ModelDescriptor[]>(`${API_ROOT}/models`);
}

export async function getSpeechCapabilities(): Promise<SpeechCapabilities> {
  return fetchJson<SpeechCapabilities>(`${API_ROOT}/speech/capabilities`);
}

export async function getAgents(): Promise<AgentSummary[]> {
  return fetchJson<AgentSummary[]>(`${API_ROOT}/agents`);
}

export async function getAgent(agentId: string): Promise<AgentSummary> {
  return fetchJson<AgentSummary>(`${API_ROOT}/agents/${agentId}`);
}

export async function getSessions(
  agentId: string,
  state: SessionListState = "active"
): Promise<ChatSessionSummary[]> {
  return fetchJson<ChatSessionSummary[]>(
    `${API_ROOT}/agents/${agentId}/sessions?state=${encodeURIComponent(state)}`
  );
}

export async function getSession(
  agentId: string,
  sessionId: string
): Promise<ChatSession> {
  return fetchJson<ChatSession>(
    `${API_ROOT}/agents/${agentId}/sessions/${sessionId}`
  );
}

export async function getScheduledTasks(
  agentId?: string
): Promise<ScheduledTask[]> {
  return fetchJson<ScheduledTask[]>(
    agentId
      ? `${API_ROOT}/agents/${agentId}/schedules`
      : `${API_ROOT}/schedules`
  );
}

export async function createScheduledTask(
  agentId: string,
  input: ScheduledTaskCreate
): Promise<ScheduledTask> {
  return fetchJsonWithInit<ScheduledTask>(
    `${API_ROOT}/agents/${agentId}/schedules`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
    }
  );
}

export async function updateScheduledTask(
  agentId: string,
  taskId: string,
  input: ScheduledTaskUpdate
): Promise<ScheduledTask> {
  return fetchJsonWithInit<ScheduledTask>(
    `${API_ROOT}/agents/${agentId}/schedules/${taskId}`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
    }
  );
}

export async function runScheduledTask(
  agentId: string,
  taskId: string
): Promise<ScheduledTask> {
  return fetchJsonWithInit<ScheduledTask>(
    `${API_ROOT}/agents/${agentId}/schedules/${taskId}/run`,
    {
      method: "POST",
    }
  );
}

export async function deleteScheduledTask(
  agentId: string,
  taskId: string
): Promise<void> {
  await fetchOk(`${API_ROOT}/agents/${agentId}/schedules/${taskId}`, {
    method: "DELETE",
  });
}

export async function deleteSession(
  agentId: string,
  sessionId: string,
  mode: SessionDeleteMode
): Promise<void> {
  await fetchOk(
    `${API_ROOT}/agents/${agentId}/sessions/${sessionId}?mode=${encodeURIComponent(mode)}`,
    {
      method: "DELETE",
    }
  );
}

export async function restoreSession(
  agentId: string,
  sessionId: string
): Promise<void> {
  await fetchOk(`${API_ROOT}/agents/${agentId}/sessions/${sessionId}/restore`, {
    method: "POST",
  });
}

export async function transcribeAudio(
  audio: Blob,
  options?: TranscriptionOptions & {
    filename?: string;
    signal?: AbortSignal;
  }
): Promise<TranscriptionResult> {
  const body = new FormData();
  body.append("file", audio, options?.filename ?? "recording.webm");
  if (options?.language) {
    body.append("language", options.language);
  }
  if (options?.prompt) {
    body.append("prompt", options.prompt);
  }
  if (options?.model) {
    body.append("model", options.model);
  }
  if (typeof options?.temperature === "number") {
    body.append("temperature", String(options.temperature));
  }
  if (options?.responseFormat) {
    body.append("responseFormat", options.responseFormat);
  }

  return fetchJsonWithInit<TranscriptionResult>(
    `${API_ROOT}/speech/transcriptions`,
    {
      method: "POST",
      body,
      signal: options?.signal,
    }
  );
}

export async function synthesizeSpeech(
  request: SpeechSynthesisRequest,
  options?: {
    signal?: AbortSignal;
  }
): Promise<Blob> {
  return fetchBlobWithInit(`${API_ROOT}/speech/speech`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(request),
    signal: options?.signal,
  });
}

export async function streamChat(
  agentId: string,
  request: ChatRequest,
  callbacks: StreamChatCallbacks
): Promise<void> {
  const prompt = request.prompt.trim();
  const threadId = request.sessionId ?? createId("thread");
  const optimisticThread = createOptimisticThread({
    agentId,
    existingThread: callbacks.thread,
    prompt,
    request,
    threadId,
  });
  const toolCalls = new Map<string, PendingToolCall>();
  const assistantSnapshotEmitter = createAssistantSnapshotEmitter((event) => {
    callbacks.onEvent(event);
  });
  let assistantTextRaw = "";
  let assistantText = "";
  let thinkingText = "";
  let streamError: string | undefined;

  callbacks.onEvent({
    type: "thread",
    thread: optimisticThread,
  });

  const agent = new HttpAgent({
    initialMessages: buildRunAgentMessages(callbacks.thread, prompt),
    initialState: {},
    threadId,
    url: `${API_ROOT}/agents/${agentId}/chat`,
  });
  const abortListener = () => agent.abortRun();
  callbacks.signal?.addEventListener("abort", abortListener);

  try {
    await agent.runAgent(
      {
        context: [],
        forwardedProps: buildForwardedProps(request, optimisticThread.title),
        runId: createId("run"),
        tools: [],
      },
      createStreamSubscriber({
        onAssistantSnapshot() {
          assistantSnapshotEmitter.queue({
            ...(assistantText ? { assistantText } : {}),
            ...(thinkingText ? { thinkingText } : {}),
          });
        },
        onError(error) {
          assistantSnapshotEmitter.flush();
          streamError = error;
          callbacks.onEvent({
            type: "error",
            error,
          });
        },
        onReasoningDelta(delta) {
          thinkingText += delta;
        },
        onSkillCall(skillCall) {
          assistantSnapshotEmitter.flush();
          callbacks.onEvent({
            type: "skill_call",
            skillCallId: skillCall.toolCallId,
            skillInput: skillCall.skillInput,
            skillName: skillCall.skillName,
          });
        },
        onSkillMeta(meta) {
          const current = toolCalls.get(meta.toolCallId);
          if (!current) {
            return;
          }
          current.exitCode = meta.exitCode;
        },
        onSkillResult(toolCallId, skillOutput) {
          assistantSnapshotEmitter.flush();
          const skillCall = toolCalls.get(toolCallId);
          callbacks.onEvent({
            type: "skill_result",
            exitCode: skillCall?.exitCode ?? 0,
            skillCallId: toolCallId,
            skillName: skillCall?.skillName ?? "unknown-skill",
            skillOutput,
          });
        },
        onTextDelta(delta) {
          assistantTextRaw += delta;
          assistantText = sanitizeVisibleAssistantText(assistantTextRaw);
        },
        toolCalls,
      })
    );
  } catch (error) {
    assistantSnapshotEmitter.cancel();
    if (callbacks.signal?.aborted) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }

    if (streamError) {
      return;
    }

    throw new Error(
      error instanceof Error ? error.message : "Unknown AG-UI stream error."
    );
  } finally {
    callbacks.signal?.removeEventListener("abort", abortListener);
  }

  if (streamError) {
    return;
  }

  assistantSnapshotEmitter.flush();
  const assistantTurn = createAssistantTurn({
    agentId,
    assistantText,
    threadId,
    thinkingText,
  });
  const completedThread = createCompletedThread(
    optimisticThread,
    assistantTurn
  );
  callbacks.onEvent({
    type: "complete",
    response: {
      assistantTurn,
      thread: completedThread,
    },
  });
}

function createStreamSubscriber(options: {
  onAssistantSnapshot: () => void;
  onError: (error: string) => void;
  onReasoningDelta: (delta: string) => void;
  onSkillCall: (skillCall: PendingToolCall) => void;
  onSkillMeta: (meta: GemmaSkillResultMeta) => void;
  onSkillResult: (toolCallId: string, skillOutput: string) => void;
  onTextDelta: (delta: string) => void;
  toolCalls: Map<string, PendingToolCall>;
}): AgentSubscriber {
  return {
    onCustomEvent({ event }) {
      const meta = parseGemmaSkillResultMeta(event);
      if (meta) {
        options.onSkillMeta(meta);
      }
    },
    onReasoningMessageContentEvent({ event }) {
      options.onReasoningDelta(event.delta);
      options.onAssistantSnapshot();
    },
    onRunErrorEvent({ event }) {
      options.onError(event.message);
    },
    onTextMessageContentEvent({ event }) {
      options.onTextDelta(event.delta);
      options.onAssistantSnapshot();
    },
    onToolCallArgsEvent({ event }) {
      const current = options.toolCalls.get(event.toolCallId);
      if (!current) {
        return;
      }
      current.skillInput += event.delta;
    },
    onToolCallEndEvent({ event }) {
      const current = options.toolCalls.get(event.toolCallId);
      if (!current) {
        return;
      }
      options.onSkillCall(current);
    },
    onToolCallResultEvent({ event }) {
      options.onSkillResult(event.toolCallId, event.content);
      options.toolCalls.delete(event.toolCallId);
    },
    onToolCallStartEvent({ event }) {
      options.toolCalls.set(event.toolCallId, {
        skillInput: "",
        skillName: event.toolCallName,
        toolCallId: event.toolCallId,
      });
    },
  };
}

function createAssistantSnapshotEmitter(
  emitEvent: (
    event: Extract<ChatStreamEvent, { type: "assistant_snapshot" }>
  ) => void
): {
  cancel: () => void;
  flush: () => void;
  queue: (
    snapshot: Omit<
      Extract<ChatStreamEvent, { type: "assistant_snapshot" }>,
      "type"
    >
  ) => void;
} {
  let latestSnapshot:
    | Omit<Extract<ChatStreamEvent, { type: "assistant_snapshot" }>, "type">
    | undefined;
  let lastSnapshotKey = "";
  let timer: ReturnType<typeof setTimeout> | undefined;

  const emitLatestSnapshot = () => {
    timer = undefined;
    if (
      !latestSnapshot ||
      (!latestSnapshot.assistantText && !latestSnapshot.thinkingText)
    ) {
      latestSnapshot = undefined;
      return;
    }
    const nextSnapshot = latestSnapshot;
    latestSnapshot = undefined;
    const nextSnapshotKey = JSON.stringify(nextSnapshot);
    if (nextSnapshotKey === lastSnapshotKey) {
      return;
    }
    lastSnapshotKey = nextSnapshotKey;
    emitEvent({
      type: "assistant_snapshot",
      ...nextSnapshot,
    });
  };

  return {
    cancel() {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      latestSnapshot = undefined;
    },
    flush() {
      if (timer) {
        clearTimeout(timer);
      }
      emitLatestSnapshot();
    },
    queue(snapshot) {
      latestSnapshot = snapshot;
      if (timer) {
        return;
      }
      timer = setTimeout(emitLatestSnapshot, SNAPSHOT_FLUSH_INTERVAL_MS);
    },
  };
}

function sanitizeVisibleAssistantText(text: string): string {
  let sanitized = text;

  for (const pattern of COMPLETE_SKILL_CALL_BLOCKS) {
    sanitized = sanitized.replace(pattern, "");
  }

  const firstPartialIndex = PARTIAL_SKILL_CALL_MARKERS.reduce<number>(
    (currentIndex, marker) => {
      const markerIndex = sanitized.indexOf(marker);
      if (markerIndex < 0) {
        return currentIndex;
      }
      return currentIndex < 0
        ? markerIndex
        : Math.min(currentIndex, markerIndex);
    },
    -1
  );

  return firstPartialIndex >= 0
    ? sanitized.slice(0, firstPartialIndex)
    : sanitized;
}

function buildRunAgentMessages(
  thread: ChatSession | undefined,
  prompt: string
): Message[] {
  const history = (thread?.turns ?? [])
    .filter(
      (turn): turn is ChatTurn & { sender: "assistant" | "user" } =>
        turn.sender === "assistant" || turn.sender === "user"
    )
    .map<Message>((turn) => ({
      content: turn.bodyMarkdown,
      id: turn.messageId,
      role: turn.sender,
    }));

  return [
    ...history,
    {
      content: prompt,
      id: createId("user"),
      role: "user",
    },
  ];
}

function buildForwardedProps(request: ChatRequest, title: string) {
  return {
    ...(request.config ? { config: request.config } : {}),
    title,
  };
}

function createOptimisticThread(input: {
  agentId: string;
  existingThread: ChatSession | undefined;
  prompt: string;
  request: ChatRequest;
  threadId: string;
}): ChatSession {
  const createdAt = new Date().toISOString();
  const title =
    input.request.title?.trim() ||
    input.existingThread?.title ||
    input.prompt.slice(0, 72) ||
    "New Gemma chat";
  const userTurn: ChatTurn = {
    bodyMarkdown: input.prompt,
    createdAt,
    messageId: createId("turn-user"),
    relativePath: "in-flight",
    sender: "user",
  };

  if (!input.existingThread) {
    return {
      agentId: input.agentId,
      manifestPath: `agents/${input.agentId}/history/${input.threadId}/SESSION.md`,
      sessionId: input.threadId,
      startedAt: createdAt,
      summary: "Pending summary.",
      title,
      turnCount: 1,
      turns: [userTurn],
      lastTurnAt: createdAt,
    };
  }

  return {
    ...input.existingThread,
    lastTurnAt: createdAt,
    title,
    turnCount: input.existingThread.turns.length + 1,
    turns: [...input.existingThread.turns, userTurn],
  };
}

function createAssistantTurn(input: {
  agentId: string;
  assistantText: string;
  threadId: string;
  thinkingText: string;
}): ChatTurn {
  const createdAt = new Date().toISOString();
  return {
    bodyMarkdown: input.assistantText,
    createdAt,
    messageId: createId("turn-assistant"),
    relativePath: `agents/${input.agentId}/history/${input.threadId}/assistant.md`,
    sender: "assistant",
    ...(input.thinkingText ? { thinkingMarkdown: input.thinkingText } : {}),
  };
}

function createCompletedThread(
  optimisticThread: ChatSession,
  assistantTurn: ChatTurn
): ChatSession {
  const turns = [...optimisticThread.turns, assistantTurn];
  return {
    ...optimisticThread,
    lastTurnAt: assistantTurn.createdAt,
    summary: summarizeAssistantText(assistantTurn.bodyMarkdown),
    turnCount: turns.length,
    turns,
  };
}

function summarizeAssistantText(assistantText: string): string {
  const firstSentence = assistantText
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .find((sentence) => sentence.trim().length > 0);
  return firstSentence?.slice(0, 240) ?? "Pending summary.";
}

function parseGemmaSkillResultMeta(
  event: CustomEvent
): GemmaSkillResultMeta | undefined {
  if (event.name !== GEMMA_SKILL_RESULT_EVENT) {
    return undefined;
  }

  const value =
    event.value &&
    typeof event.value === "object" &&
    !Array.isArray(event.value)
      ? (event.value as Record<string, unknown>)
      : undefined;
  if (
    typeof value?.toolCallId !== "string" ||
    typeof value.exitCode !== "number"
  ) {
    return undefined;
  }

  return {
    exitCode: value.exitCode,
    toolCallId: value.toolCallId,
  };
}

function createId(prefix: string): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) {
    return `${prefix}-${uuid}`;
  }

  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function fetchJson<T>(url: string): Promise<T> {
  return fetchJsonWithInit<T>(url);
}

async function fetchJsonWithInit<T>(
  url: string,
  init?: RequestInit
): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(await getResponseErrorMessage(response, "Request failed"));
  }
  return (await response.json()) as T;
}

async function fetchOk(url: string, init?: RequestInit): Promise<void> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(await getResponseErrorMessage(response, "Request failed"));
  }
}

async function fetchBlobWithInit(
  url: string,
  init?: RequestInit
): Promise<Blob> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(await getResponseErrorMessage(response, "Request failed"));
  }
  return response.blob();
}

async function getResponseErrorMessage(
  response: Response,
  fallbackMessage: string
): Promise<string> {
  const responseText = (await response.text()).trim();
  if (!responseText) {
    return `${fallbackMessage} with status ${response.status}.`;
  }

  if (isJsonResponse(response)) {
    const payload = parseJsonRecord(responseText);
    const message = payloadMessage(payload);
    if (message) {
      return message;
    }
  }

  return responseText;
}

function isJsonResponse(response: Response): boolean {
  return (
    response.headers.get("content-type")?.toLowerCase().includes("json") ??
    false
  );
}

function parseJsonRecord(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch (error) {
    if (error instanceof SyntaxError) {
      return undefined;
    }
    throw error;
  }
}

function payloadMessage(
  payload: Record<string, unknown> | undefined
): string | undefined {
  if (typeof payload?.error === "string") {
    return payload.error;
  }
  if (typeof payload?.message === "string") {
    return payload.message;
  }
  return undefined;
}

export const __testing = {
  buildRunAgentMessages,
  createAssistantSnapshotEmitter,
  createCompletedThread,
  createOptimisticThread,
  getResponseErrorMessage,
  parseGemmaSkillResultMeta,
  parseJsonRecord,
  payloadMessage,
  SNAPSHOT_FLUSH_INTERVAL_MS,
  sanitizeVisibleAssistantText,
  summarizeAssistantText,
};
