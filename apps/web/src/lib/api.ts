import {
  type AgentSummary,
  type ChatRequest,
  type ChatSession,
  type ChatSessionSummary,
  type ChatStreamEvent,
  chatStreamEventSchema,
  type HealthStatus,
  type ModelDescriptor,
  type SessionDeleteMode,
  type SessionListState,
} from "@gemma-agent-pwa/contracts";

const API_ROOT = import.meta.env.VITE_API_BASE_URL ?? "/api";

export async function getHealth(): Promise<HealthStatus> {
  return fetchJson<HealthStatus>(`${API_ROOT}/health`);
}

export async function getModels(): Promise<ModelDescriptor[]> {
  return fetchJson<ModelDescriptor[]>(`${API_ROOT}/models`);
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

export async function streamChat(
  agentId: string,
  request: ChatRequest,
  callbacks: {
    signal?: AbortSignal;
    onEvent: (event: ChatStreamEvent) => void;
  }
): Promise<void> {
  const response = await fetch(`${API_ROOT}/agents/${agentId}/chat`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(request),
    signal: callbacks.signal,
  });
  if (!response.ok) {
    throw new Error(
      await getResponseErrorMessage(response, "Chat request failed")
    );
  }
  if (!response.body) {
    throw new Error("The chat stream did not return a readable body.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = createChatStreamEventParser();

  while (true) {
    const { done, value } = await reader.read();
    const chunk = decoder.decode(value, { stream: !done });
    for (const event of parser.pushChunk(chunk)) {
      callbacks.onEvent(event);
    }
    if (done) {
      for (const event of parser.flush()) {
        callbacks.onEvent(event);
      }
      break;
    }
  }
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
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

function createChatStreamEventParser(): {
  flush: () => ChatStreamEvent[];
  pushChunk: (chunk: string) => ChatStreamEvent[];
} {
  let buffer = "";

  return {
    pushChunk(chunk) {
      buffer += chunk;
      const result = consumeChatStreamBuffer(buffer);
      buffer = result.remainingBuffer;
      return result.events;
    },
    flush() {
      const result = consumeChatStreamBuffer(buffer, { flush: true });
      buffer = result.remainingBuffer;
      return result.events;
    },
  };
}

function consumeChatStreamBuffer(
  buffer: string,
  options?: { flush?: boolean }
): {
  events: ChatStreamEvent[];
  remainingBuffer: string;
} {
  const events: ChatStreamEvent[] = [];
  let remainingBuffer = buffer;
  let newlineIndex = remainingBuffer.indexOf("\n");

  while (newlineIndex >= 0) {
    const rawLine = remainingBuffer.slice(0, newlineIndex);
    remainingBuffer = remainingBuffer.slice(newlineIndex + 1);
    const event = parseChatStreamEventLine(rawLine);
    if (event) {
      events.push(event);
    }
    newlineIndex = remainingBuffer.indexOf("\n");
  }

  if (options?.flush) {
    const event = parseChatStreamEventLine(remainingBuffer);
    remainingBuffer = "";
    if (event) {
      events.push(event);
    }
  }

  return { events, remainingBuffer };
}

function parseChatStreamEventLine(
  rawLine: string
): ChatStreamEvent | undefined {
  const line = rawLine.trim();
  if (!line) {
    return undefined;
  }

  try {
    return chatStreamEventSchema.parse(JSON.parse(line));
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof Error) {
      throw new Error(`Invalid chat stream event payload: ${line}`);
    }
    throw error;
  }
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
  consumeChatStreamBuffer,
  createChatStreamEventParser,
  getResponseErrorMessage,
  parseChatStreamEventLine,
  parseJsonRecord,
  payloadMessage,
};
