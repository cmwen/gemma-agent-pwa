import type { ChatRequest } from "@gemma-agent-pwa/contracts";
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

describe("stream chat parsing", () => {
  it("reassembles newline-delimited JSON events across chunk boundaries", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      createStreamResponse([
        '{"type":"assistant_snapshot","assistantText":"Hel',
        'lo"}\n{"type":"error","error":"Network hiccup"}\n',
      ])
    );
    const events: Array<Record<string, unknown>> = [];

    await streamChat("release-planner", buildChatRequest(), {
      onEvent: (event) => events.push(event),
    });

    expect(events).toEqual([
      {
        type: "assistant_snapshot",
        assistantText: "Hello",
      },
      {
        type: "error",
        error: "Network hiccup",
      },
    ]);
  });

  it("accepts CRLF-delimited events and trailing buffered content", () => {
    const parser = __testing.createChatStreamEventParser();

    const chunkEvents = parser.pushChunk(
      '\r\n{"type":"assistant_snapshot","thinkingText":"Plan"}\r\n'
    );
    const flushedEvents = parser.pushChunk(
      '{"type":"assistant_snapshot","assistantText":"Done"}'
    );

    expect(chunkEvents).toEqual([
      {
        type: "assistant_snapshot",
        thinkingText: "Plan",
      },
    ]);
    expect(flushedEvents).toEqual([]);
    expect(parser.flush()).toEqual([
      {
        type: "assistant_snapshot",
        assistantText: "Done",
      },
    ]);
  });

  it("surfaces server error payloads in request failures", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "Agent not found." }), {
        status: 404,
        headers: {
          "content-type": "application/json",
        },
      })
    );

    await expect(
      streamChat("missing-agent", buildChatRequest(), {
        onEvent: vi.fn(),
      })
    ).rejects.toThrow("Agent not found.");
  });

  it("throws a clear error for malformed stream events", () => {
    expect(() =>
      __testing.parseChatStreamEventLine(
        '{"type":"assistant_snapshot","assistantText":1}'
      )
    ).toThrow(
      'Invalid chat stream event payload: {"type":"assistant_snapshot","assistantText":1}'
    );
  });
});

function buildChatRequest(): ChatRequest {
  return {
    prompt: "Outline the release checklist.",
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
        "content-type": "application/x-ndjson",
      },
    }
  );
}
