import type { MinKbWorkspace } from "@gemma-agent-pwa/min-kb-bridge";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  deleteSession: vi.fn(),
  getAgentById: vi.fn(),
  getSession: vi.fn(),
  listAgents: vi.fn(),
  listAvailableModels: vi.fn(),
  listSessions: vi.fn(),
  loadAgentSkills: vi.fn(),
  recordSessionLlmUsage: vi.fn(),
  registerScheduledTaskRoutes: vi.fn(),
  restoreSession: vi.fn(),
  runChatLoop: vi.fn(),
  saveChatTurn: vi.fn(),
  softDeleteSession: vi.fn(),
  startScheduledTaskRunner: vi.fn(),
  streamProviderChat: vi.fn(),
  summarizeWorkspace: vi.fn(),
}));

vi.mock("@gemma-agent-pwa/min-kb-bridge", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@gemma-agent-pwa/min-kb-bridge")>();
  return {
    ...actual,
    deleteSession: mocks.deleteSession,
    getAgentById: mocks.getAgentById,
    getSession: mocks.getSession,
    listAgents: mocks.listAgents,
    listSessions: mocks.listSessions,
    recordSessionLlmUsage: mocks.recordSessionLlmUsage,
    restoreSession: mocks.restoreSession,
    saveChatTurn: mocks.saveChatTurn,
    softDeleteSession: mocks.softDeleteSession,
    summarizeWorkspace: mocks.summarizeWorkspace,
  };
});

vi.mock("./agent-skills.js", () => ({
  createLoadSkillTool: vi.fn().mockReturnValue(undefined),
  executeLoadSkillTool: vi.fn(),
  LOAD_SKILL_TOOL_NAME: "load-skill",
  loadAgentSkills: mocks.loadAgentSkills,
}));

vi.mock("./chat-loop.js", () => ({
  runChatLoop: mocks.runChatLoop,
}));

vi.mock("./llm-provider.js", () => ({
  getProviderModelCatalog: vi.fn(),
  listAvailableModels: mocks.listAvailableModels,
  streamProviderChat: mocks.streamProviderChat,
}));

vi.mock("./scheduled-tasks.js", () => ({
  registerScheduledTaskRoutes: mocks.registerScheduledTaskRoutes,
  startScheduledTaskRunner: mocks.startScheduledTaskRunner,
}));

import { __testing, createApiApp } from "./app.js";

const workspace: MinKbWorkspace = {
  storeRoot: "/tmp/min-kb-store",
  agentsRoot: "/tmp/min-kb-store/agents",
  memoryRoot: "/tmp/min-kb-store/memory",
  skillsRoot: "/tmp/min-kb-store/skills",
  copilotConfigDir: "/tmp/.copilot",
  copilotSkillsRoot: "/tmp/.copilot/skills",
};

beforeEach(() => {
  mocks.startScheduledTaskRunner.mockReturnValue({
    refresh: vi.fn(),
  });
  mocks.registerScheduledTaskRoutes.mockImplementation(() => undefined);
  mocks.loadAgentSkills.mockResolvedValue([]);
  mocks.recordSessionLlmUsage.mockResolvedValue(undefined);
  mocks.getSession.mockRejectedValue(new Error("Session not found."));
  mocks.listAvailableModels.mockResolvedValue([
    {
      id: "google/gemma-4b-it",
      displayName: "Gemma 4B Instruct",
      provider: "LM Studio",
      isGemma: true,
    },
  ]);
  mocks.streamProviderChat.mockResolvedValue({
    assistantText: "Release planning",
    llmStats: {
      recordedAt: "2026-05-07T00:00:00.000Z",
      model: "google/gemma-4b-it",
      requestCount: 1,
      inputTokens: 12,
      outputTokens: 3,
      durationMs: 90,
    },
  });
});

afterEach(() => {
  vi.resetAllMocks();
});

describe("app helpers", () => {
  it("prioritizes Gemma 4 models for the configured provider golden path", () => {
    expect(
      __testing.chooseDefaultModel([
        {
          id: "google/gemma-3-12b",
          displayName: "Gemma 3 12B",
          provider: "LM Studio",
          isGemma: true,
        },
        {
          id: "google/gemma-4b-it",
          displayName: "Gemma 4B Instruct",
          provider: "LM Studio",
          isGemma: true,
        },
      ])
    ).toMatchObject({
      id: "google/gemma-4b-it",
    });
  });

  it("normalizes forwarded LM Studio chat config without dropping the title", () => {
    const parsed = __testing.parseForwardedProps({
      title: "  Release planning  ",
      config: {
        provider: " LM Studio ",
        model: "google/gemma-4b-it",
        presetId: "gemma4-fast",
        lmStudioEnableThinking: false,
      },
    });

    expect(parsed).toMatchObject({
      title: "Release planning",
      config: {
        provider: "lmstudio",
        model: "google/gemma-4b-it",
        presetId: "gemma4-fast",
        lmStudioEnableThinking: false,
      },
    });
    expect(parsed.config).not.toHaveProperty("disabledSkills");
  });

  it("rejects forwarded runtime configs for unconfigured providers", () => {
    expect(() =>
      __testing.parseForwardedProps({
        config: {
          provider: "future-provider",
          model: "google/gemma-4b-it",
        },
      })
    ).toThrow(
      'Unsupported LLM provider "future-provider". LM Studio is the only configured provider.'
    );
  });

  it("falls back to a generic title when generated output echoes the prompt", () => {
    expect(
      __testing.sanitizeConversationTitle(
        "How do I fix the mobile conversation title?",
        "How do I fix the mobile conversation title?"
      )
    ).toBe("New Gemma chat");
  });
});

describe("createApiApp chat route", () => {
  it("streams the LM Studio golden path and persists merged runtime config", async () => {
    const userTurn = {
      messageId: "turn-user-1",
      sender: "user",
      createdAt: "2026-05-07T00:00:00.000Z",
      bodyMarkdown: "Outline the release checklist.",
      relativePath: "agents/release-planner/history/session-1/user.md",
    };
    const assistantTurn = {
      messageId: "turn-assistant-1",
      sender: "assistant",
      createdAt: "2026-05-07T00:00:02.000Z",
      bodyMarkdown: "Release checklist ready.",
      thinkingMarkdown: "Plan the rollout first.",
      relativePath: "agents/release-planner/history/session-1/assistant.md",
    };
    mocks.getAgentById.mockResolvedValue({
      id: "release-planner",
      kind: "planner",
      title: "Release Planner",
      combinedPrompt: "You are a release planner.",
      delegatedAgentIds: ["qa-tasker"],
      runtimeConfig: {
        provider: "lmstudio",
        presetId: "gemma4-fast",
        lmStudioEnableThinking: true,
        maxCompletionTokens: 2048,
        contextWindowSize: 32768,
        temperature: 0.2,
        topP: 0.92,
        disabledSkills: ["skip-me"],
      },
    });
    mocks.saveChatTurn
      .mockResolvedValueOnce({
        agentId: "release-planner",
        manifestPath: "agents/release-planner/history/session-1/SESSION.md",
        sessionId: "session-1",
        startedAt: "2026-05-07T00:00:00.000Z",
        summary: "Pending summary.",
        title: "Release planning",
        turnCount: 1,
        turns: [userTurn],
      })
      .mockResolvedValueOnce({
        agentId: "release-planner",
        manifestPath: "agents/release-planner/history/session-1/SESSION.md",
        sessionId: "session-1",
        startedAt: "2026-05-07T00:00:00.000Z",
        summary: "Release checklist ready.",
        title: "Release planning",
        turnCount: 2,
        turns: [userTurn, assistantTurn],
      });
    mocks.runChatLoop.mockImplementation(async (input) => {
      await input.emitEvent?.({
        type: "assistant_snapshot",
        assistantText: "Release checklist ready.",
        thinkingText: "Plan the rollout first.",
      });
      return {
        assistantText: "Release checklist ready.",
        thinkingText: "Plan the rollout first.",
        conversationTurns: [userTurn, assistantTurn],
        llmStats: {
          recordedAt: "2026-05-07T00:00:02.000Z",
          model: "google/gemma-4b-it",
          requestCount: 1,
          inputTokens: 32,
          outputTokens: 6,
          durationMs: 120,
        },
      };
    });

    const app = createApiApp(workspace);
    const response = await app.request("/api/agents/release-planner/chat", {
      method: "POST",
      headers: {
        accept: "text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        context: [],
        forwardedProps: {
          title: "  Release planning  ",
          config: {
            provider: "LM Studio",
            presetId: "gemma4-deep",
            lmStudioEnableThinking: false,
            topP: 0.7,
          },
        },
        messages: [
          {
            id: "turn-user-1",
            role: "user",
            content: "Outline the release checklist.",
          },
        ],
        runId: "run-1",
        state: {},
        threadId: "session-1",
        tools: [],
      }),
    });

    expect(response.status).toBe(200);
    const responseText = await response.text();
    expect(responseText).toContain("RUN_STARTED");
    expect(responseText).toContain("RUN_FINISHED");
    expect(responseText).toContain("Release checklist ready.");
    expect(mocks.runChatLoop).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "release-planner",
        agentPrompt: "You are a release planner.",
        config: expect.objectContaining({
          provider: "lmstudio",
          model: "google/gemma-4b-it",
          presetId: "gemma4-deep",
          lmStudioEnableThinking: false,
          topP: 0.7,
          disabledSkills: ["skip-me"],
        }),
        sessionId: "session-1",
        tools: [
          expect.objectContaining({
            name: "delegate-task",
            metadata: expect.objectContaining({
              delegatedAgentIds: ["qa-tasker"],
            }),
          }),
        ],
      })
    );
    expect(mocks.saveChatTurn).toHaveBeenNthCalledWith(
      1,
      workspace,
      expect.objectContaining({
        agentId: "release-planner",
        sender: "user",
        title: "Release planning",
        runtimeConfig: expect.objectContaining({
          provider: "lmstudio",
          model: "google/gemma-4b-it",
          presetId: "gemma4-deep",
          lmStudioEnableThinking: false,
          topP: 0.7,
        }),
      })
    );
    expect(mocks.recordSessionLlmUsage).toHaveBeenCalledWith(
      workspace,
      "release-planner",
      "session-1",
      expect.objectContaining({
        model: "google/gemma-4b-it",
        outputTokens: 6,
        tokensPerSecond: 50,
      })
    );
  });

  it("forwards the latest user prompt unchanged through the LM Studio route", async () => {
    const prompt = "Outline the release checklist for the mobile launch.";
    const userTurn = {
      messageId: "turn-user-1",
      sender: "user",
      createdAt: "2026-05-07T00:00:00.000Z",
      bodyMarkdown: prompt,
      relativePath: "agents/release-planner/history/session-1/user.md",
    };
    const assistantTurn = {
      messageId: "turn-assistant-1",
      sender: "assistant",
      createdAt: "2026-05-07T00:00:02.000Z",
      bodyMarkdown: "Release checklist ready.",
      relativePath: "agents/release-planner/history/session-1/assistant.md",
    };
    mocks.getAgentById.mockResolvedValue({
      id: "release-planner",
      combinedPrompt: "You are a release planner.",
      runtimeConfig: {
        provider: "lmstudio",
        presetId: "gemma4-balanced",
        lmStudioEnableThinking: true,
        maxCompletionTokens: 4096,
        contextWindowSize: 32768,
        temperature: 0.2,
        topP: 0.95,
        disabledSkills: [],
      },
    });
    mocks.saveChatTurn
      .mockResolvedValueOnce({
        agentId: "release-planner",
        manifestPath: "agents/release-planner/history/session-1/SESSION.md",
        sessionId: "session-1",
        startedAt: "2026-05-07T00:00:00.000Z",
        summary: "Pending summary.",
        title: "Release planning",
        turnCount: 1,
        turns: [userTurn],
      })
      .mockResolvedValueOnce({
        agentId: "release-planner",
        manifestPath: "agents/release-planner/history/session-1/SESSION.md",
        sessionId: "session-1",
        startedAt: "2026-05-07T00:00:00.000Z",
        summary: "Release checklist ready.",
        title: "Release planning",
        turnCount: 2,
        turns: [userTurn, assistantTurn],
      });
    mocks.runChatLoop.mockResolvedValue({
      assistantText: "Release checklist ready.",
      conversationTurns: [userTurn, assistantTurn],
      llmStats: {
        recordedAt: "2026-05-07T00:00:02.000Z",
        model: "google/gemma-4b-it",
        requestCount: 1,
        inputTokens: 32,
        outputTokens: 6,
        durationMs: 120,
      },
    });

    const app = createApiApp(workspace);
    const response = await app.request("/api/agents/release-planner/chat", {
      method: "POST",
      headers: {
        accept: "text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        context: [],
        messages: [
          {
            id: "turn-user-1",
            role: "user",
            content: prompt,
          },
        ],
        runId: "run-1",
        state: {},
        threadId: "session-1",
        tools: [],
      }),
    });

    expect(response.status).toBe(200);
    await response.text();
    expect(mocks.streamProviderChat).toHaveBeenCalledWith(
      expect.objectContaining({
        conversation: [
          expect.objectContaining({
            bodyMarkdown: expect.stringContaining(
              "Create a short conversation title"
            ),
            sender: "system",
          }),
          expect.objectContaining({
            bodyMarkdown: prompt,
            sender: "user",
          }),
        ],
      })
    );
    expect(mocks.saveChatTurn).toHaveBeenNthCalledWith(
      1,
      workspace,
      expect.objectContaining({
        bodyMarkdown: prompt,
        sender: "user",
        title: "Release planning",
      })
    );
    expect(mocks.runChatLoop).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          provider: "lmstudio",
        }),
        conversationTurns: [userTurn],
      })
    );
  });
});
