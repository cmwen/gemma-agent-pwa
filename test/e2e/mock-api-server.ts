import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { EventType, RunAgentInputSchema } from "@ag-ui/core";
import { EventEncoder } from "@ag-ui/encoder";
import type {
  AgentSummary,
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
    const input = RunAgentInputSchema.parse(
      JSON.parse(await readRequestBody(request))
    );
    const forwardedProps =
      input.forwardedProps &&
      typeof input.forwardedProps === "object" &&
      !Array.isArray(input.forwardedProps)
        ? (input.forwardedProps as Record<string, unknown>)
        : {};
    const now = new Date().toISOString();
    const sessionId = input.threadId;
    const prompt = extractLatestUserPrompt(input.messages).trim();
    const title =
      typeof forwardedProps.title === "string" && forwardedProps.title.trim()
        ? forwardedProps.title.trim()
        : "Streamed mobile test";
    const config =
      forwardedProps.config &&
      typeof forwardedProps.config === "object" &&
      !Array.isArray(forwardedProps.config)
        ? (forwardedProps.config as Record<string, unknown>)
        : {};
    const model =
      typeof config.model === "string"
        ? config.model
        : (models[0]?.id ?? "unknown");
    const thinkingEnabled = config.lmStudioEnableThinking !== false;
    const maxTokens =
      typeof config.maxCompletionTokens === "number"
        ? config.maxCompletionTokens
        : 0;
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
      title,
      startedAt: now,
      lastTurnAt: now,
      summary: "Streaming mobile test",
      manifestPath: `agents/${agent.id}/history/${sessionId}/SESSION.md`,
      turnCount: 1,
      turns: [userTurn],
      runtimeConfig: {
        provider: "lmstudio",
        model,
        presetId:
          typeof config.presetId === "string"
            ? config.presetId
            : "gemma4-balanced",
        lmStudioEnableThinking: thinkingEnabled,
        maxCompletionTokens: maxTokens,
        temperature:
          typeof config.temperature === "number" ? config.temperature : 0.2,
        topP: typeof config.topP === "number" ? config.topP : 0.95,
        disabledSkills: Array.isArray(config.disabledSkills)
          ? config.disabledSkills.filter(
              (value): value is string => typeof value === "string"
            )
          : [],
      },
    };

    const encoder = new EventEncoder({ accept: request.headers.accept });
    response.writeHead(200, {
      "content-type": `${encoder.getContentType()}; charset=utf-8`,
      "cache-control": "no-store",
      connection: "keep-alive",
      "transfer-encoding": "chunked",
    });

    writeEvent(response, encoder, {
      type: EventType.RUN_STARTED,
      runId: input.runId,
      threadId: input.threadId,
    });
    await delay(120);
    if (/release checklist skill/i.test(prompt)) {
      writeEvent(response, encoder, {
        type: EventType.TOOL_CALL_START,
        toolCallId: "tool-1",
        toolCallName: "release-checklist",
      });
      writeEvent(response, encoder, {
        type: EventType.TOOL_CALL_ARGS,
        delta: '{"scope":"mobile"}',
        toolCallId: "tool-1",
      });
      writeEvent(response, encoder, {
        type: EventType.TOOL_CALL_END,
        toolCallId: "tool-1",
      });
      await delay(120);
      writeEvent(response, encoder, {
        type: EventType.CUSTOM,
        name: "gemma-skill-result",
        value: {
          exitCode: 0,
          toolCallId: "tool-1",
        },
      });
      writeEvent(response, encoder, {
        type: EventType.TOOL_CALL_RESULT,
        content: "Checklist drafted for mobile release.",
        messageId: "tool-result-1",
        toolCallId: "tool-1",
      });
      await delay(1500);
      writeEvent(response, encoder, {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "assistant-1",
        role: "assistant",
      });
      writeEvent(response, encoder, {
        type: EventType.TEXT_MESSAGE_CONTENT,
        delta: "Release checklist ready for the mobile rollout.",
        messageId: "assistant-1",
      });

      const assistantTurn = {
        messageId: "turn-assistant-1",
        sender: "assistant" as const,
        createdAt: new Date().toISOString(),
        bodyMarkdown: "Release checklist ready for the mobile rollout.",
        relativePath: `agents/${agent.id}/history/${sessionId}/turn-assistant-1.md`,
      };

      completedSession = {
        ...thread,
        lastTurnAt: assistantTurn.createdAt,
        summary: assistantTurn.bodyMarkdown,
        turnCount: 2,
        turns: [userTurn, assistantTurn],
      };

      await delay(120);
      writeEvent(response, encoder, {
        type: EventType.TEXT_MESSAGE_END,
        messageId: "assistant-1",
      });
      writeEvent(response, encoder, {
        type: EventType.RUN_FINISHED,
        outcome: {
          type: "success",
        },
        runId: input.runId,
        threadId: input.threadId,
      });
      response.end();
      return;
    }

    if (/long mobile scroll/i.test(prompt)) {
      const assistantParagraphs = Array.from(
        { length: 18 },
        (_, index) =>
          `Paragraph ${index + 1}: This is intentionally long mobile-friendly release guidance so the conversation timeline grows tall enough to verify touch scrolling while the assistant is still streaming.`
      );
      const assistantMarkdown = [
        `Streaming reply for ${model}`,
        "",
        ...assistantParagraphs,
      ].join("\n\n");

      writeEvent(response, encoder, {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "assistant-1",
        role: "assistant",
      });

      let streamedMarkdown = `Streaming reply for ${model}`;
      writeEvent(response, encoder, {
        type: EventType.TEXT_MESSAGE_CONTENT,
        delta: streamedMarkdown,
        messageId: "assistant-1",
      });

      for (const paragraph of assistantParagraphs) {
        await delay(120);
        const delta = `\n\n${paragraph}`;
        streamedMarkdown += delta;
        writeEvent(response, encoder, {
          type: EventType.TEXT_MESSAGE_CONTENT,
          delta,
          messageId: "assistant-1",
        });
      }

      const assistantTurn = {
        messageId: "turn-assistant-1",
        sender: "assistant" as const,
        createdAt: new Date().toISOString(),
        bodyMarkdown: assistantMarkdown,
        relativePath: `agents/${agent.id}/history/${sessionId}/turn-assistant-1.md`,
      };

      completedSession = {
        ...thread,
        lastTurnAt: assistantTurn.createdAt,
        summary: `Streaming reply for ${model}`,
        turnCount: 2,
        turns: [userTurn, assistantTurn],
      };

      writeEvent(response, encoder, {
        type: EventType.TEXT_MESSAGE_END,
        messageId: "assistant-1",
      });
      writeEvent(response, encoder, {
        type: EventType.RUN_FINISHED,
        outcome: {
          type: "success",
        },
        runId: input.runId,
        threadId: input.threadId,
      });
      response.end();
      return;
    }

    if (thinkingEnabled) {
      writeEvent(response, encoder, {
        type: EventType.REASONING_START,
        messageId: "reasoning-1",
      });
      writeEvent(response, encoder, {
        type: EventType.REASONING_MESSAGE_START,
        messageId: "reasoning-1",
        role: "reasoning",
      });
      writeEvent(response, encoder, {
        type: EventType.REASONING_MESSAGE_CONTENT,
        delta: "Compare the mobile layout before shipping.",
        messageId: "reasoning-1",
      });
    }
    const assistantMarkdown = [
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
    ].join("\n");

    writeEvent(response, encoder, {
      type: EventType.TEXT_MESSAGE_START,
      messageId: "assistant-1",
      role: "assistant",
    });
    writeEvent(response, encoder, {
      type: EventType.TEXT_MESSAGE_CONTENT,
      delta: `Streaming reply for ${model}\n\n- thinking: ${
        thinkingEnabled ? "on" : "off"
      }`,
      messageId: "assistant-1",
    });
    await delay(120);
    if (thinkingEnabled) {
      writeEvent(response, encoder, {
        type: EventType.REASONING_MESSAGE_CONTENT,
        delta: "\nThen confirm the streamed text stays readable.",
        messageId: "reasoning-1",
      });
    }
    writeEvent(response, encoder, {
      type: EventType.TEXT_MESSAGE_CONTENT,
      delta: `\n- tokens: ${maxTokens}\n- mobile: wrapped`,
      messageId: "assistant-1",
    });
    await delay(120);
    writeEvent(response, encoder, {
      type: EventType.TEXT_MESSAGE_CONTENT,
      delta: [
        "",
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
      messageId: "assistant-1",
    });
    await delay(120);

    const assistantTurn = {
      messageId: "turn-assistant-1",
      sender: "assistant" as const,
      createdAt: new Date().toISOString(),
      bodyMarkdown: assistantMarkdown,
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

    writeEvent(response, encoder, {
      type: EventType.TEXT_MESSAGE_END,
      messageId: "assistant-1",
    });
    if (thinkingEnabled) {
      writeEvent(response, encoder, {
        type: EventType.REASONING_MESSAGE_END,
        messageId: "reasoning-1",
      });
      writeEvent(response, encoder, {
        type: EventType.REASONING_END,
        messageId: "reasoning-1",
      });
    }
    writeEvent(response, encoder, {
      type: EventType.RUN_FINISHED,
      outcome: {
        type: "success",
      },
      runId: input.runId,
      threadId: input.threadId,
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

function writeEvent(
  response: ServerResponse,
  encoder: EventEncoder,
  event: unknown
): void {
  response.write(encoder.encode(event as never));
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

function extractLatestUserPrompt(
  messages: Array<{ role: string; content?: unknown }>
) {
  const latestUserMessage = [...messages]
    .reverse()
    .find((message) => message.role === "user");
  if (!latestUserMessage) {
    throw new Error("AG-UI test input must include a user message.");
  }
  if (typeof latestUserMessage.content === "string") {
    return latestUserMessage.content;
  }
  if (!Array.isArray(latestUserMessage.content)) {
    return "";
  }
  return latestUserMessage.content
    .flatMap((content) =>
      content &&
      typeof content === "object" &&
      "type" in content &&
      "text" in content &&
      content.type === "text" &&
      typeof content.text === "string"
        ? [content.text]
        : []
    )
    .join("\n");
}
