import type { MinKbWorkspace } from "@gemma-agent-pwa/min-kb-bridge";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAgentById: vi.fn(),
  listAvailableModels: vi.fn(),
  loadAgentSkills: vi.fn(),
  recordSessionLlmUsage: vi.fn(),
  runChatLoop: vi.fn(),
  saveChatTurn: vi.fn(),
}));

vi.mock("@gemma-agent-pwa/min-kb-bridge", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@gemma-agent-pwa/min-kb-bridge")>();
  return {
    ...actual,
    getAgentById: mocks.getAgentById,
    recordSessionLlmUsage: mocks.recordSessionLlmUsage,
    saveChatTurn: mocks.saveChatTurn,
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
  listAvailableModels: mocks.listAvailableModels,
}));

import { executeDelegatedAgentTool } from "./delegation.js";

const workspace: MinKbWorkspace = {
  storeRoot: "/tmp/min-kb-store",
  agentsRoot: "/tmp/min-kb-store/agents",
  memoryRoot: "/tmp/min-kb-store/memory",
  skillsRoot: "/tmp/min-kb-store/skills",
  copilotConfigDir: "/tmp/.copilot",
  copilotSkillsRoot: "/tmp/.copilot/skills",
};

describe("executeDelegatedAgentTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listAvailableModels.mockResolvedValue([
      {
        id: "google/gemma-4b-it",
        displayName: "Gemma 4B Instruct",
        provider: "LM Studio",
        isGemma: true,
      },
    ]);
    mocks.getAgentById.mockResolvedValue({
      id: "qa-tasker",
      title: "QA Tasker",
      combinedPrompt: "Check releases carefully.",
      delegatedAgentIds: [],
      runtimeConfig: {
        provider: "lmstudio",
        presetId: "gemma4-fast",
        lmStudioEnableThinking: false,
        disabledSkills: ["qa-memory"],
      },
    });
    mocks.saveChatTurn
      .mockResolvedValueOnce({
        agentId: "qa-tasker",
        manifestPath: "agents/qa-tasker/history/session-qa/SESSION.md",
        sessionId: "session-qa",
        startedAt: "2026-05-13T00:00:00.000Z",
        summary: "Pending summary.",
        title: "Release Orchestrator · QA Tasker",
        turnCount: 1,
        turns: [
          {
            messageId: "turn-user-1",
            sender: "user",
            createdAt: "2026-05-13T00:00:00.000Z",
            bodyMarkdown: "Check the release checklist.",
            relativePath: "in-flight",
          },
        ],
      })
      .mockResolvedValueOnce({
        agentId: "qa-tasker",
        manifestPath: "agents/qa-tasker/history/session-qa/SESSION.md",
        sessionId: "session-qa",
        startedAt: "2026-05-13T00:00:00.000Z",
        summary: "Checklist verified.",
        title: "Release Orchestrator · QA Tasker",
        turnCount: 2,
        turns: [],
      });
    mocks.loadAgentSkills.mockResolvedValue([]);
    mocks.runChatLoop.mockResolvedValue({
      assistantText: "Checklist verified.",
      conversationTurns: [],
      llmStats: {
        recordedAt: "2026-05-13T00:00:00.000Z",
        model: "google/gemma-4b-it",
        requestCount: 1,
        inputTokens: 10,
        outputTokens: 3,
        durationMs: 100,
      },
    });
    mocks.recordSessionLlmUsage.mockResolvedValue(undefined);
  });

  it("inherits the parent-selected model when the delegated agent does not override it", async () => {
    await executeDelegatedAgentTool(
      workspace,
      {
        allowedAgentIds: ["qa-tasker"],
        parentAgentId: "release-orchestrator",
        parentSessionId: "session-parent",
        parentAgentTitle: "Release Orchestrator",
        parentConfig: {
          provider: "lmstudio",
          model: "google/gemma-4-27b-it",
          presetId: "gemma4-deep",
          lmStudioEnableThinking: true,
          maxCompletionTokens: 8192,
          contextWindowSize: 32768,
          temperature: 0.15,
          topP: 0.95,
          disabledSkills: [],
        },
      },
      '{"agentId":"qa-tasker","prompt":"Check the release checklist."}'
    );

    expect(mocks.saveChatTurn).toHaveBeenNthCalledWith(
      1,
      workspace,
      expect.objectContaining({
        runtimeConfig: expect.objectContaining({
          model: "google/gemma-4-27b-it",
          presetId: "gemma4-fast",
          lmStudioEnableThinking: false,
        }),
      })
    );
    expect(mocks.runChatLoop).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          model: "google/gemma-4-27b-it",
          presetId: "gemma4-fast",
        }),
      })
    );
  });
});
