import type { ChatRequest, ChatSession } from "@gemma-agent-pwa/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __testing,
  deleteSession,
  getSessions,
  restoreSession,
  streamChat,
} from "./api";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("session API helpers", () => {
  it("requests the selected session list state", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("[]", {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      })
    );

    await getSessions("release-planner", "deleted");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/agents/release-planner/sessions?state=deleted"
    );
  });

  it("uses the delete mode query parameter for session removal", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));

    await deleteSession("release-planner", "session-1", "permanent");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/agents/release-planner/sessions/session-1?mode=permanent",
      { method: "DELETE" }
    );
  });

  it("posts to the restore endpoint", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));

    await restoreSession("release-planner", "session-1");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/agents/release-planner/sessions/session-1/restore",
      { method: "POST" }
    );
  });
});

describe("AG-UI chat streaming", () => {
  it("maps AG-UI SSE events back into the chat UI stream model", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        createStreamResponse([
          'data: {"type":"RUN_STARTED","threadId":"session-1","runId":"run-1"}\n\n',
          'data: {"type":"REASONING_START","messageId":"reasoning-1"}\n\n',
          'data: {"type":"REASONING_MESSAGE_START","messageId":"reasoning-1","role":"reasoning"}\n\n',
          'data: {"type":"REASONING_MESSAGE_CONTENT","messageId":"reasoning-1","delta":"Plan"}\n\n',
          'data: {"type":"TEXT_MESSAGE_START","messageId":"assistant-1","role":"assistant"}\n\n',
          'data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"assistant-1","delta":"Hello"}\n\n',
          'data: {"type":"TEXT_MESSAGE_END","messageId":"assistant-1"}\n\n',
          'data: {"type":"REASONING_MESSAGE_END","messageId":"reasoning-1"}\n\n',
          'data: {"type":"REASONING_END","messageId":"reasoning-1"}\n\n',
          'data: {"type":"RUN_FINISHED","threadId":"session-1","runId":"run-1","outcome":{"type":"success"}}\n\n',
        ])
      );
    const events: Array<Record<string, unknown>> = [];

    await streamChat(
      "release-planner",
      buildChatRequest({ sessionId: "session-1" }),
      {
        onEvent: (event) => events.push(event),
        thread: buildThread(),
      }
    );

    expect(events).toHaveLength(4);
    expect(events[0]).toMatchObject({
      type: "thread",
      thread: {
        sessionId: "session-1",
      },
    });
    expect(events[1]).toEqual({
      type: "assistant_snapshot",
      thinkingText: "Plan",
    });
    expect(events[2]).toEqual({
      type: "assistant_snapshot",
      assistantText: "Hello",
      thinkingText: "Plan",
    });
    expect(events[3]).toMatchObject({
      type: "complete",
      response: {
        thread: {
          sessionId: "session-1",
          turnCount: 4,
        },
      },
    });

    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(init).toBeDefined();
    expect(init).toMatchObject({
      method: "POST",
      headers: expect.objectContaining({
        Accept: "text/event-stream",
        "Content-Type": "application/json",
      }),
    });
    const body = JSON.parse(String((init as RequestInit).body)) as Record<
      string,
      unknown
    >;
    expect(body.threadId).toBe("session-1");
    expect(body.runId).toEqual(expect.any(String));
    expect(body.messages).toMatchObject([
      { id: "turn-1", role: "user", content: "Outline the release checklist." },
      { id: "turn-2", role: "assistant", content: "Start with tests." },
      { role: "user", content: "Outline the release checklist." },
    ]);
    expect(body.forwardedProps).toMatchObject({
      title: "Release planning",
    });
  });

  it("surfaces AG-UI run errors in the existing error event shape", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      createStreamResponse([
        'data: {"type":"RUN_STARTED","threadId":"session-1","runId":"run-1"}\n\n',
        'data: {"type":"RUN_ERROR","message":"Agent not found."}\n\n',
      ])
    );
    const events: Array<Record<string, unknown>> = [];

    await streamChat(
      "missing-agent",
      buildChatRequest({ sessionId: "session-1" }),
      {
        onEvent: (event) => events.push(event),
        thread: buildThread(),
      }
    );

    expect(events.at(-1)).toEqual({
      type: "error",
      error: "Agent not found.",
    });
  });

  it("retains tool exit codes from AG-UI custom metadata events", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      createStreamResponse([
        'data: {"type":"RUN_STARTED","threadId":"session-1","runId":"run-1"}\n\n',
        'data: {"type":"TOOL_CALL_START","toolCallId":"tool-1","toolCallName":"release-checklist"}\n\n',
        'data: {"type":"TOOL_CALL_ARGS","toolCallId":"tool-1","delta":"{\\"scope\\":\\"mobile\\"}"}\n\n',
        'data: {"type":"TOOL_CALL_END","toolCallId":"tool-1"}\n\n',
        'data: {"type":"CUSTOM","name":"gemma-skill-result","value":{"toolCallId":"tool-1","exitCode":1}}\n\n',
        'data: {"type":"TOOL_CALL_RESULT","messageId":"tool-result-1","toolCallId":"tool-1","content":"missing files"}\n\n',
        'data: {"type":"RUN_FINISHED","threadId":"session-1","runId":"run-1","outcome":{"type":"success"}}\n\n',
      ])
    );
    const events: Array<Record<string, unknown>> = [];

    await streamChat(
      "release-planner",
      buildChatRequest({ sessionId: "session-1" }),
      {
        onEvent: (event) => events.push(event),
        thread: buildThread(),
      }
    );

    expect(events).toContainEqual({
      type: "skill_call",
      skillCallId: "tool-1",
      skillInput: '{"scope":"mobile"}',
      skillName: "release-checklist",
    });
    expect(events).toContainEqual({
      type: "skill_result",
      exitCode: 1,
      skillCallId: "tool-1",
      skillName: "release-checklist",
      skillOutput: "missing files",
    });
  });
});

describe("helper utilities", () => {
  it("summarizes assistant text using the first sentence", () => {
    expect(
      __testing.summarizeAssistantText(
        "Ship the mobile fixes first. Then verify the desktop layout."
      )
    ).toBe("Ship the mobile fixes first.");
  });

  it("hides complete and partial skill call markup from streamed assistant text", () => {
    expect(
      __testing.sanitizeVisibleAssistantText(
        'Before<skill_call name="release-checklist">{"scope":"mobile"}</skill_call>After'
      )
    ).toBe("BeforeAfter");
    expect(
      __testing.sanitizeVisibleAssistantText(
        'Before<skill_call name="release-checklist">{"scope":"mobile"}'
      )
    ).toBe("Before");
    expect(
      __testing.sanitizeVisibleAssistantText(
        '<|tool_call>call:release-checklist{"scope":"mobile"}<tool_call|>'
      )
    ).toBe("");
  });
});

function buildChatRequest(overrides?: Partial<ChatRequest>): ChatRequest {
  return {
    prompt: "Outline the release checklist.",
    ...overrides,
  };
}

function buildThread(): ChatSession {
  return {
    agentId: "release-planner",
    manifestPath: "agents/release-planner/history/session-1/SESSION.md",
    sessionId: "session-1",
    startedAt: "2026-04-06T21:00:00.000Z",
    summary: "Release planning",
    title: "Release planning",
    turnCount: 2,
    turns: [
      {
        bodyMarkdown: "Outline the release checklist.",
        createdAt: "2026-04-06T21:00:00.000Z",
        messageId: "turn-1",
        relativePath: "agents/release-planner/history/session-1/turn-user-1.md",
        sender: "user",
      },
      {
        bodyMarkdown: "Start with tests.",
        createdAt: "2026-04-06T21:01:00.000Z",
        messageId: "turn-2",
        relativePath:
          "agents/release-planner/history/session-1/turn-assistant-1.md",
        sender: "assistant",
      },
    ],
  };
}

function createStreamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();

  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    }),
    {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
      },
    }
  );
}
