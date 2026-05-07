import { describe, expect, it, vi } from "vitest";

const { getLmStudioModelCatalog, listLmStudioModels, streamLmStudioChat } =
  vi.hoisted(() => ({
    getLmStudioModelCatalog: vi.fn(),
    listLmStudioModels: vi.fn(),
    streamLmStudioChat: vi.fn(),
  }));

vi.mock("./lmstudio.js", () => ({
  getLmStudioModelCatalog,
  listLmStudioModels,
  streamLmStudioChat,
}));

import {
  getProviderModelCatalog,
  listAvailableModels,
  streamProviderChat,
} from "./llm-provider.js";

describe("LLM provider dispatch", () => {
  it("routes chat streaming through the LM Studio provider", async () => {
    const onSnapshot = vi.fn();
    streamLmStudioChat.mockResolvedValueOnce({
      assistantText: "Release checklist ready.",
      llmStats: {
        recordedAt: "2026-05-07T00:00:00.000Z",
        model: "google/gemma-4b-it",
        requestCount: 1,
        inputTokens: 24,
        outputTokens: 8,
        durationMs: 120,
      },
    });

    await expect(
      streamProviderChat({
        model: "google/gemma-4b-it",
        config: {
          provider: "lmstudio",
          model: "google/gemma-4b-it",
          presetId: "gemma4-balanced",
          lmStudioEnableThinking: true,
          maxCompletionTokens: 4096,
          contextWindowSize: 32768,
          temperature: 0.2,
          topP: 0.95,
          disabledSkills: [],
        },
        conversation: [],
        enabledSkills: [],
        onSnapshot,
      })
    ).resolves.toMatchObject({
      assistantText: "Release checklist ready.",
    });

    expect(streamLmStudioChat).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          provider: "lmstudio",
        }),
        model: "google/gemma-4b-it",
        onSnapshot,
      })
    );
  });

  it("lists models and health through the LM Studio provider", async () => {
    listLmStudioModels.mockResolvedValueOnce([
      {
        id: "google/gemma-4b-it",
        displayName: "Gemma 4B Instruct",
        provider: "LM Studio",
        isGemma: true,
      },
    ]);
    getLmStudioModelCatalog.mockResolvedValueOnce({
      models: [],
      reachable: true,
    });

    await expect(listAvailableModels()).resolves.toHaveLength(1);
    await expect(getProviderModelCatalog()).resolves.toEqual({
      models: [],
      reachable: true,
    });
  });

  it("normalizes LM Studio aliases before resolving the configured adapter", async () => {
    listLmStudioModels.mockResolvedValueOnce([]);

    await expect(listAvailableModels("LM Studio")).resolves.toEqual([]);
  });

  it("fails fast for unsupported providers until another adapter is configured", async () => {
    await expect(listAvailableModels("future-provider")).rejects.toThrow(
      'Unsupported LLM provider "future-provider". LM Studio is the only configured provider.'
    );
  });
});
