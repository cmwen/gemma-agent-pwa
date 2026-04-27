import type {
  AgentSummary,
  ChatRequest,
  ChatSession,
  ChatSessionSummary,
  ChatStreamEvent,
  HealthStatus,
  ModelDescriptor,
  SessionDeleteMode,
  SessionListState,
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
    throw new Error(`Chat request failed with status ${response.status}.`);
  }
  if (!response.body) {
    throw new Error("The chat stream did not return a readable body.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line) {
        callbacks.onEvent(JSON.parse(line) as ChatStreamEvent);
      }
      newlineIndex = buffer.indexOf("\n");
    }
    if (done) {
      const trailing = buffer.trim();
      if (trailing) {
        callbacks.onEvent(JSON.parse(trailing) as ChatStreamEvent);
      }
      break;
    }
  }
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}.`);
  }
  return (await response.json()) as T;
}

async function fetchOk(url: string, init?: RequestInit): Promise<void> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}.`);
  }
}
