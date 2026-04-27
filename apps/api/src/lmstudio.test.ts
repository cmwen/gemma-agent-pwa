import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LoadedSkillDocument } from "../../../packages/min-kb-bridge/src/agents.js";
import {
  __testing,
  getLmStudioModelCatalog,
  streamLmStudioChat,
} from "./lmstudio.js";

const originalLmStudioModel = process.env.LM_STUDIO_MODEL;
const originalLmStudioBaseUrl = process.env.LM_STUDIO_BASE_URL;

afterEach(() => {
  vi.restoreAllMocks();
  if (originalLmStudioModel === undefined) {
    delete process.env.LM_STUDIO_MODEL;
  } else {
    process.env.LM_STUDIO_MODEL = originalLmStudioModel;
  }
  if (originalLmStudioBaseUrl === undefined) {
    delete process.env.LM_STUDIO_BASE_URL;
  } else {
    process.env.LM_STUDIO_BASE_URL = originalLmStudioBaseUrl;
  }
});

describe("lmstudio parsing", () => {
  it("separates leading thinking blocks from visible content", () => {
    expect(
      __testing.extractPayloadSections(
        "<think>Review the prompt carefully.</think>\n\nFinal answer."
      )
    ).toEqual({
      assistantText: "Final answer.",
      thinkingText: "Review the prompt carefully.",
    });
  });

  it("combines repeated streaming snapshots without duplication", () => {
    expect(
      __testing.combineTextCandidates([
        "Plan the migration.",
        "Plan the migration.\nThen summarize the risk.",
        "Plan the migration.",
      ])
    ).toBe("Plan the migration.\nThen summarize the risk.");
  });

  it("appends incremental streaming deltas without inserting blank lines", () => {
    const accumulator = new __testing.StreamAccumulator();

    expect(
      accumulator.consumeChunk({
        choices: [{ delta: { content: "Plan" } }],
      })
    ).toEqual({
      assistantText: "Plan",
    });
    expect(
      accumulator.consumeChunk({
        choices: [{ delta: { content: " the migration" } }],
      })
    ).toEqual({
      assistantText: "Plan the migration",
    });
    expect(
      accumulator.consumeChunk({
        choices: [{ delta: { content: ".\nThen summarize the risk." } }],
      })
    ).toEqual({
      assistantText: "Plan the migration.\nThen summarize the risk.",
    });
  });

  it("parses plain JSON completion bodies when SSE framing is absent", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          model: "google/gemma-3-4b",
          usage: {
            prompt_tokens: 11,
            completion_tokens: 7,
          },
          choices: [
            {
              message: {
                content: "Final answer.",
              },
            },
          ],
        })
      )
    );

    await expect(
      streamLmStudioChat({
        model: "google/gemma-3-4b",
        config: {
          provider: "lmstudio",
          model: "google/gemma-3-4b",
          presetId: "gemma4-balanced",
          lmStudioEnableThinking: true,
          maxCompletionTokens: 4096,
          temperature: 0.2,
          topP: 0.95,
          disabledSkills: [],
        },
        conversation: [
          {
            messageId: "turn-1",
            sender: "user",
            createdAt: "2026-04-16T00:00:00.000Z",
            bodyMarkdown: "Hello",
            relativePath: "agents/test/history/session-1/turn-1.md",
          },
        ],
        enabledSkills: [],
        onSnapshot: vi.fn(),
      })
    ).resolves.toMatchObject({
      assistantText: "Final answer.",
      llmStats: {
        model: "google/gemma-3-4b",
        requestCount: 1,
        inputTokens: 11,
        outputTokens: 7,
      },
    });
  });

  it("surfaces SSE stream error messages from LM Studio", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                [
                  "event: error",
                  'data: {"message":"Prompt exceeds context length."}',
                  "",
                  "",
                ].join("\n")
              )
            );
            controller.close();
          },
        })
      )
    );

    await expect(
      streamLmStudioChat({
        model: "google/gemma-3-4b",
        config: {
          provider: "lmstudio",
          model: "google/gemma-3-4b",
          presetId: "gemma4-balanced",
          lmStudioEnableThinking: true,
          maxCompletionTokens: 4096,
          temperature: 0.2,
          topP: 0.95,
          disabledSkills: [],
        },
        conversation: [
          {
            messageId: "turn-1",
            sender: "user",
            createdAt: "2026-04-16T00:00:00.000Z",
            bodyMarkdown: "Hello",
            relativePath: "agents/test/history/session-1/turn-1.md",
          },
        ],
        enabledSkills: [],
        onSnapshot: vi.fn(),
      })
    ).rejects.toThrow("Prompt exceeds context length.");
  });

  it("keeps enabled skill summaries compact enough for smaller context windows", () => {
    const longTail =
      "Tail detail that should not fully survive truncation. ".repeat(80);
    const prompt = __testing.buildSystemPrompt("Follow the agent contract.", [
      {
        name: "search-store",
        description: "Search notes by title or content.",
        scope: "agent-local",
        path: "agents/logseq/skills/search-store/SKILL.md",
        sourceRoot: "agents/logseq/skills",
        hasScript: true,
        scriptPath: "agents/logseq/skills/search-store/scripts/search_store.py",
        content: [
          "Search notes by title or content.",
          'Use a JSON object like {"query":"weekly review","limit":5} when you need named arguments.',
          longTail,
        ].join("\n\n"),
      } satisfies LoadedSkillDocument,
    ]);

    expect(prompt).toContain("### search-store");
    expect(prompt).toContain("Search notes by title or content.");
    expect(prompt).toContain(
      'Use a JSON object like {"query":"weekly review","limit":5} when you need named arguments.'
    );
    expect(prompt).not.toContain(longTail);
  });

  it("does not send descriptor metadata for skills into the prompt", () => {
    const prompt = __testing.buildSystemPrompt("Follow the agent contract.", [
      {
        name: "search-store",
        description: "Hidden metadata description.",
        scope: "agent-local",
        path: "agents/logseq/skills/search-store/SKILL.md",
        sourceRoot: "agents/logseq/skills",
        hasScript: true,
        scriptPath: "agents/logseq/skills/search-store/scripts/search_store.py",
        content: [
          "Search notes by title or content.",
          'Use a JSON object like {"query":"weekly review"} when needed.',
        ].join("\n\n"),
      } satisfies LoadedSkillDocument,
    ]);

    expect(prompt).toContain("Search notes by title or content.");
    expect(prompt).not.toContain("Hidden metadata description.");
    expect(prompt).not.toContain("Scope:");
    expect(prompt).not.toContain("Description:");
  });
});

describe("LM Studio model catalog", () => {
  it("marks configured fallback models as unavailable when discovery fails", async () => {
    process.env.LM_STUDIO_MODEL = "google/gemma-3-4b";
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("connect ECONNREFUSED")
    );

    await expect(getLmStudioModelCatalog()).resolves.toEqual({
      models: [
        {
          id: "google/gemma-3-4b",
          displayName: "google/gemma-3-4b",
          provider: "LM Studio",
          isGemma: true,
        },
      ],
      reachable: false,
    });
  });

  it("falls back to localhost model discovery when loopback is unreachable", async () => {
    delete process.env.LM_STUDIO_BASE_URL;
    vi.spyOn(os, "hostname").mockReturnValue("minipc-wsl");
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((input) => {
        if (input === "http://127.0.0.1:1234/v1/models") {
          return Promise.reject(new Error("connect ECONNREFUSED"));
        }
        if (input === "http://localhost:1234/v1/models") {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                data: [{ id: "google/gemma-3-4b", owned_by: "LM Studio" }],
              })
            )
          );
        }
        return Promise.reject(new Error(`Unexpected URL: ${String(input)}`));
      });

    await expect(getLmStudioModelCatalog()).resolves.toEqual({
      models: [
        {
          id: "google/gemma-3-4b",
          displayName: "google/gemma-3-4b",
          provider: "LM Studio",
          isGemma: true,
        },
      ],
      reachable: true,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe("LM Studio URL helpers", () => {
  it("includes the current hostname in default candidate URLs", () => {
    delete process.env.LM_STUDIO_BASE_URL;
    vi.spyOn(os, "hostname").mockReturnValue("minipc-wsl");

    expect(__testing.getBaseUrlCandidates()).toContain(
      "http://minipc-wsl:1234/v1"
    );
  });
});

describe("rolling context window", () => {
  it("estimates tokens from text length", () => {
    // 12 chars → ceil(12/4) + 4 overhead = 7
    expect(__testing.estimateTokens("Hello world!")).toBe(7);
    // empty → ceil(0/4) + 4 = 4
    expect(__testing.estimateTokens("")).toBe(4);
  });

  it("keeps all messages when within budget", () => {
    const messages = [
      { role: "user" as const, content: "Hi" },
      { role: "assistant" as const, content: "Hello!" },
      { role: "user" as const, content: "How are you?" },
    ];
    const result = __testing.trimToContextWindow(messages, 10_000);
    expect(result).toEqual(messages);
  });

  it("trims oldest messages when over budget", () => {
    const messages = [
      {
        role: "user" as const,
        content: "First message that is fairly long and should be trimmed",
      },
      {
        role: "assistant" as const,
        content: "First reply that is also fairly long and should be trimmed",
      },
      { role: "user" as const, content: "Recent question" },
      { role: "assistant" as const, content: "Recent answer" },
    ];
    // Budget enough for only the last 2 messages
    const recentTokens =
      __testing.estimateTokens("Recent question") +
      __testing.estimateTokens("Recent answer");
    const result = __testing.trimToContextWindow(messages, recentTokens);
    expect(result).toEqual([
      { role: "user", content: "Recent question" },
      { role: "assistant", content: "Recent answer" },
    ]);
  });

  it("always keeps at least the last message even when budget is zero", () => {
    const messages = [{ role: "user" as const, content: "Only message" }];
    const result = __testing.trimToContextWindow(messages, 0);
    expect(result).toEqual([{ role: "user", content: "Only message" }]);
  });

  it("returns empty array when no messages exist", () => {
    expect(__testing.trimToContextWindow([], 100)).toEqual([]);
  });

  it("buildMessages trims conversation to fit context window", () => {
    const conversation = Array.from({ length: 20 }, (_, i) => ({
      messageId: `turn-${i}`,
      sender: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      createdAt: "2026-04-16T00:00:00.000Z",
      bodyMarkdown: `Message ${i} ${"x".repeat(200)}`,
      relativePath: `turns/turn-${i}.md`,
    }));

    // Tiny context window that can't fit all messages
    const result = __testing.buildMessages(
      conversation,
      "You are a helpful assistant.",
      [],
      { contextWindowSize: 512, maxCompletionTokens: 128 }
    );

    // System prompt should always be first
    expect(result[0]?.role).toBe("system");
    // Should have fewer messages than the original 20
    expect(result.length).toBeLessThan(21);
    // Last message should be the most recent turn
    expect(result[result.length - 1]?.content).toContain("Message 19");
  });

  it("buildMessages keeps all messages when context window is large enough", () => {
    const conversation = [
      {
        messageId: "turn-1",
        sender: "user" as const,
        createdAt: "2026-04-16T00:00:00.000Z",
        bodyMarkdown: "Hello",
        relativePath: "turns/turn-1.md",
      },
      {
        messageId: "turn-2",
        sender: "assistant" as const,
        createdAt: "2026-04-16T00:00:01.000Z",
        bodyMarkdown: "Hi there!",
        relativePath: "turns/turn-2.md",
      },
    ];

    const result = __testing.buildMessages(
      conversation,
      "You are helpful.",
      [],
      { contextWindowSize: 32_768, maxCompletionTokens: 4096 }
    );

    // System + 2 conversation turns
    expect(result).toHaveLength(3);
    expect(result[0]?.role).toBe("system");
    expect(result[1]?.content).toBe("Hello");
    expect(result[2]?.content).toBe("Hi there!");
  });
});
