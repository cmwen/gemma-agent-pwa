import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type {
  AgentSummary,
  ChatRequest,
  ChatSession,
  ChatSessionSummary,
  HealthStatus,
  ModelDescriptor,
} from "@gemma-agent-pwa/contracts";

const port = Number(process.env.PORT ?? 8787);
const models: ModelDescriptor[] = [
  {
    id: "google/gemma-4b-it",
    displayName: "Gemma 4B Instruct",
    provider: "LM Studio",
    isGemma: true,
  },
  {
    id: "google/gemma-3-4b",
    displayName: "Gemma 3 4B",
    provider: "LM Studio",
    isGemma: true,
  },
];
const agent: AgentSummary = {
  id: "release-planner",
  kind: "chat",
  title: "Release planner",
  description: "Plans release tasks for the local Gemma PWA.",
  combinedPrompt: "Help the user plan and ship releases.",
  agentPath: "agents/release-planner/AGENT.md",
  defaultSoulPath: "agents/release-planner/SOUL.md",
  historyRoot: "agents/release-planner/history",
  workingMemoryRoot: "agents/release-planner/memory",
  skillRoot: "agents/release-planner/skills",
  skillNames: ["release-checklist"],
  sessionCount: 0,
  runtimeConfig: {
    provider: "lmstudio",
    model: "google/gemma-4b-it",
    presetId: "gemma4-balanced",
    lmStudioEnableThinking: true,
    maxCompletionTokens: 4096,
    temperature: 0.2,
    topP: 0.95,
    disabledSkills: [],
  },
};
const health: HealthStatus = {
  ok: true,
  workspace: {
    storeRoot: "/tmp/min-kb-store",
    copilotConfigDir: "/tmp/.config/github-copilot",
    storeSkillDirectory: "/tmp/min-kb-store/skills",
    copilotSkillDirectory: "/tmp/.config/github-copilot/skills",
    agentCount: 1,
  },
  lmStudioReachable: true,
  defaultModel: models[0]?.id,
  warmedModel: models[0]?.id,
  modelCount: models.length,
  message: "LM Studio is reachable and ready for local chat.",
};

let completedSession: ChatSession | undefined;

const server = createServer(async (request, response) => {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", `http://${request.headers.host}`);

  if (method === "GET" && url.pathname === "/api/health") {
    return writeJson(response, 200, health);
  }

  if (method === "GET" && url.pathname === "/api/models") {
    return writeJson(response, 200, models);
  }

  if (method === "POST" && url.pathname === "/api/test/reset") {
    completedSession = undefined;
    return writeJson(response, 200, { ok: true });
  }

  if (method === "GET" && url.pathname === "/api/agents") {
    const activeSessionCount =
      completedSession && !completedSession.deletedAt ? 1 : 0;
    return writeJson(response, 200, [
      { ...agent, sessionCount: activeSessionCount },
    ]);
  }

  if (method === "GET" && url.pathname === `/api/agents/${agent.id}`) {
    return writeJson(response, 200, agent);
  }

  if (method === "GET" && url.pathname === `/api/agents/${agent.id}/sessions`) {
    const state =
      url.searchParams.get("state") === "deleted" ? "deleted" : "active";
    const sessions =
      completedSession &&
      ((state === "deleted" && completedSession.deletedAt) ||
        (state === "active" && !completedSession.deletedAt))
        ? [toSessionSummary(completedSession)]
        : [];
    return writeJson(response, 200, sessions);
  }

  if (
    method === "GET" &&
    completedSession &&
    url.pathname ===
      `/api/agents/${agent.id}/sessions/${completedSession.sessionId}`
  ) {
    return writeJson(response, 200, completedSession);
  }

  if (
    method === "DELETE" &&
    completedSession &&
    url.pathname ===
      `/api/agents/${agent.id}/sessions/${completedSession.sessionId}`
  ) {
    const mode =
      url.searchParams.get("mode") === "permanent" ? "permanent" : "soft";
    if (mode === "permanent") {
      completedSession = undefined;
    } else {
      completedSession = {
        ...completedSession,
        deletedAt: new Date().toISOString(),
      };
    }
    response.writeHead(204);
    response.end();
    return;
  }

  if (
    method === "POST" &&
    completedSession &&
    url.pathname ===
      `/api/agents/${agent.id}/sessions/${completedSession.sessionId}/restore`
  ) {
    completedSession = {
      ...completedSession,
      deletedAt: undefined,
    };
    response.writeHead(204);
    response.end();
    return;
  }

  if (method === "POST" && url.pathname === `/api/agents/${agent.id}/chat`) {
    const requestBody = JSON.parse(
      await readRequestBody(request)
    ) as ChatRequest;
    const now = new Date().toISOString();
    const sessionId = requestBody.sessionId ?? "session-stream";
    const prompt = requestBody.prompt.trim();
    const model = requestBody.config?.model ?? models[0]?.id ?? "unknown";
    const thinkingEnabled =
      requestBody.config?.lmStudioEnableThinking !== false;
    const maxTokens = requestBody.config?.maxCompletionTokens ?? 0;
    const userTurn = {
      messageId: "turn-user-1",
      sender: "user" as const,
      createdAt: now,
      bodyMarkdown: prompt,
      relativePath: `agents/${agent.id}/history/${sessionId}/turn-user-1.md`,
    };
    const thread: ChatSession = {
      sessionId,
      agentId: agent.id,
      title: requestBody.title?.trim() || "Streamed mobile test",
      startedAt: now,
      lastTurnAt: now,
      summary: "Streaming mobile test",
      manifestPath: `agents/${agent.id}/history/${sessionId}/SESSION.md`,
      turnCount: 1,
      turns: [userTurn],
      runtimeConfig: {
        provider: "lmstudio",
        model,
        presetId: requestBody.config?.presetId ?? "gemma4-balanced",
        lmStudioEnableThinking: thinkingEnabled,
        maxCompletionTokens: maxTokens,
        temperature: requestBody.config?.temperature ?? 0.2,
        topP: requestBody.config?.topP ?? 0.95,
        disabledSkills: requestBody.config?.disabledSkills ?? [],
      },
    };

    response.writeHead(200, {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "transfer-encoding": "chunked",
    });

    writeEvent(response, {
      type: "thread",
      thread,
    });
    await delay(120);
    writeEvent(response, {
      type: "assistant_snapshot",
      assistantText: `Streaming reply for ${model}\n\n- thinking: ${
        thinkingEnabled ? "on" : "off"
      }`,
      thinkingText: thinkingEnabled
        ? "Compare the mobile layout before shipping."
        : undefined,
    });
    await delay(120);
    writeEvent(response, {
      type: "assistant_snapshot",
      assistantText: `Streaming reply for ${model}\n\n- thinking: ${
        thinkingEnabled ? "on" : "off"
      }\n- tokens: ${maxTokens}\n- mobile: wrapped`,
      thinkingText: thinkingEnabled
        ? "Compare the mobile layout before shipping.\nThen confirm the streamed text stays readable."
        : undefined,
    });
    await delay(120);

    const assistantTurn = {
      messageId: "turn-assistant-1",
      sender: "assistant" as const,
      createdAt: new Date().toISOString(),
      bodyMarkdown: [
        `Streaming reply for ${model}`,
        "",
        `- thinking: ${thinkingEnabled ? "on" : "off"}`,
        `- tokens: ${maxTokens}`,
        "- mobile: wrapped",
        "",
        "| Area | Status |",
        "| --- | --- |",
        "| Streaming | Ready |",
        "| Layout | Mobile friendly |",
        "",
        "```ts",
        "export function wrapInsideCard(url: string) {",
        "  return url.split('/').join('/\\n');",
        "}",
        "```",
        "",
        "`https://example.com/really/long/mobile/path/that/should/wrap/inside/the/chat/card/without/overflow`",
      ].join("\n"),
      thinkingMarkdown: thinkingEnabled
        ? "Compare the mobile layout before shipping.\nThen confirm the streamed text stays readable."
        : undefined,
      relativePath: `agents/${agent.id}/history/${sessionId}/turn-assistant-1.md`,
    };

    completedSession = {
      ...thread,
      lastTurnAt: assistantTurn.createdAt,
      summary: `Streaming reply for ${model}`,
      turnCount: 2,
      turns: [userTurn, assistantTurn],
    };

    writeEvent(response, {
      type: "complete",
      response: {
        thread: completedSession,
        assistantTurn,
      },
    });
    response.end();
    return;
  }

  writeJson(response, 404, { error: "Not found." });
});

server.listen(port, "127.0.0.1", () => {
  console.info(`Mock API listening on http://127.0.0.1:${port}`);
});

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function writeJson(
  response: ServerResponse,
  status: number,
  body: unknown
): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function writeEvent(response: ServerResponse, event: unknown): void {
  response.write(`${JSON.stringify(event)}\n`);
}

function toSessionSummary(session: ChatSession): ChatSessionSummary {
  return {
    sessionId: session.sessionId,
    agentId: session.agentId,
    title: session.title,
    startedAt: session.startedAt,
    summary: session.summary,
    manifestPath: session.manifestPath,
    turnCount: session.turnCount,
    lastTurnAt: session.lastTurnAt,
    deletedAt: session.deletedAt,
    runtimeConfig: session.runtimeConfig,
  };
}

function delay(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}
