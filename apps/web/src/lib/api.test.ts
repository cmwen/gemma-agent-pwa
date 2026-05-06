import type { ChatRequest, ChatSession } from "@gemma-agent-pwa/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __testing,
  createScheduledTask,
  deleteScheduledTask as deleteScheduledTaskRequest,
  deleteSession,
  getScheduledTasks,
  getSessions,
  restoreSession,
  runScheduledTask,
  streamChat,
  synthesizeSpeech,
  transcribeAudio,
  updateScheduledTask,
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
      "/api/agents/release-planner/sessions?state=deleted",
      undefined
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

describe("scheduled task API helpers", () => {
  it("lists global scheduled tasks when no agent is selected", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("[]", {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      })
    );

    await getScheduledTasks();

    expect(fetchMock).toHaveBeenCalledWith("/api/schedules", undefined);
  });

  it("lists scheduled tasks for a specific agent when selected", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("[]", {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      })
    );

    await getScheduledTasks("release-planner");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/agents/release-planner/schedules",
      undefined
    );
  });

  it("posts, patches, runs, and deletes scheduled tasks", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "task-1",
            agentId: "release-planner",
          }),
          {
            status: 201,
            headers: {
              "content-type": "application/json",
            },
          }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "task-1",
            agentId: "release-planner",
            enabled: false,
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "task-1",
            agentId: "release-planner",
            lastRunStatus: "success",
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          }
        )
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await createScheduledTask("release-planner", {
      agentId: "release-planner",
      title: "Hourly digest",
      prompt: "Summarize the latest activity.",
      recurrence: "hourly",
      minuteOfHour: 15,
      timezone: "UTC",
      enabled: true,
      notifyOnCompletion: true,
      sessionMode: "dedicated",
    });
    await updateScheduledTask("release-planner", "task-1", {
      enabled: false,
    });
    await runScheduledTask("release-planner", "task-1");
    await deleteScheduledTaskRequest("release-planner", "task-1");

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/agents/release-planner/schedules",
      expect.objectContaining({
        method: "POST",
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/agents/release-planner/schedules/task-1",
      expect.objectContaining({
        method: "PATCH",
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "/api/agents/release-planner/schedules/task-1/run",
      {
        method: "POST",
      }
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      "/api/agents/release-planner/schedules/task-1",
      {
        method: "DELETE",
      }
    );
  });
});

describe("speech API helpers", () => {
  it("posts multipart audio uploads for transcription", async () => {
    const controller = new AbortController();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          text: "hello world",
          model: "Systran/faster-distil-whisper-small.en",
          provider: "openai-compatible",
          raw: { text: "hello world" },
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        }
      )
    );

    await transcribeAudio(new Blob(["voice"], { type: "audio/webm" }), {
      filename: "voice.webm",
      language: "en",
      signal: controller.signal,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/api/speech/transcriptions");
    expect(init).toMatchObject({ method: "POST" });
    expect((init as RequestInit).headers).toBeUndefined();
    expect((init as RequestInit).signal).toBe(controller.signal);
    expect((init as RequestInit).body).toBeInstanceOf(FormData);
    const formData = (init as RequestInit).body as FormData;
    expect(formData.get("language")).toBe("en");
    expect(formData.get("file")).toBeInstanceOf(File);
  });

  it("returns reply audio blobs for speech synthesis", async () => {
    const controller = new AbortController();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Blob(["audio"], { type: "audio/wav" }), {
        status: 200,
        headers: {
          "content-type": "audio/wav",
        },
      })
    );

    const blob = await synthesizeSpeech(
      {
        input: "Read this aloud",
        responseFormat: "wav",
      },
      {
        signal: controller.signal,
      }
    );

    expect(blob.type).toBe("audio/wav");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/speech/speech",
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        signal: controller.signal,
      })
    );
  });

  it("surfaces API error details when speech synthesis fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          error:
            "Speech synthesis failed because min-speech-service at http://127.0.0.1:8790 is unreachable (connection to 127.0.0.1:8790 was refused). Start min-speech-service or update MIN_SPEECH_SERVICE_URL.",
        }),
        {
          status: 503,
          headers: {
            "content-type": "application/json",
          },
        }
      )
    );

    await expect(
      synthesizeSpeech({
        input: "Read this aloud",
      })
    ).rejects.toThrow(
      "Speech synthesis failed because min-speech-service at http://127.0.0.1:8790 is unreachable (connection to 127.0.0.1:8790 was refused). Start min-speech-service or update MIN_SPEECH_SERVICE_URL."
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

    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({
      type: "thread",
      thread: {
        sessionId: "session-1",
      },
    });
    expect(events[1]).toEqual({
      type: "assistant_snapshot",
      assistantText: "Hello",
      thinkingText: "Plan",
    });
    expect(events[2]).toMatchObject({
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
  it("batches assistant snapshots so the UI can render the latest state once", () => {
    vi.useFakeTimers();

    const events: Array<Record<string, unknown>> = [];
    const emitter = __testing.createAssistantSnapshotEmitter((event) => {
      events.push(event);
    });

    emitter.queue({ thinkingText: "Plan" });
    emitter.queue({
      assistantText: "Hello",
      thinkingText: "Plan",
    });

    vi.advanceTimersByTime(__testing.SNAPSHOT_FLUSH_INTERVAL_MS - 1);
    expect(events).toHaveLength(0);

    vi.advanceTimersByTime(1);
    expect(events).toEqual([
      {
        type: "assistant_snapshot",
        assistantText: "Hello",
        thinkingText: "Plan",
      },
    ]);

    vi.useRealTimers();
  });

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
