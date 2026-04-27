import type { ChatStreamEvent } from "@gemma-agent-pwa/contracts";
import { describe, expect, it } from "vitest";
import {
  buildChatRequestDebugLog,
  buildChatStreamDebugLog,
  buildLoopIterationDebugLog,
  buildLoopOutcomeDebugLog,
  buildSkillExecutionDebugLog,
  buildSkillInventoryDebugLog,
} from "./chat-debug.js";

describe("buildChatRequestDebugLog", () => {
  it("includes the request prompt and runtime config", () => {
    const message = buildChatRequestDebugLog({
      agentId: "debug-agent",
      sessionId: "session-123",
      title: "Investigate failing skill",
      prompt: "Please inspect the error path.",
      runtimeConfig: {
        provider: "lmstudio",
        model: "google/gemma-3-4b",
        presetId: "gemma4-balanced",
        lmStudioEnableThinking: true,
        maxCompletionTokens: 4096,
        contextWindowSize: 32768,
        temperature: 0.2,
        topP: 0.95,
        disabledSkills: [],
      },
    });

    expect(message.level).toBe("info");
    expect(message.text).toContain(
      "Request queued · agent=debug-agent · session=session-123 · model=google/gemma-3-4b"
    );
    expect(message.text).toContain("Prompt\nPlease inspect the error path.");
    expect(message.text).toContain('"presetId": "gemma4-balanced"');
  });
});

describe("buildChatStreamDebugLog", () => {
  const context = {
    agentId: "debug-agent",
    sessionId: "session-123",
  };

  it("formats tool calls for terminal output", () => {
    const event: ChatStreamEvent = {
      type: "skill_call",
      skillName: "search-store",
      skillInput: "release notes",
    };

    expect(buildChatStreamDebugLog(event, context)).toEqual({
      level: "info",
      text: [
        "Tool call · search-store · agent=debug-agent · session=session-123",
        "Input\nrelease notes",
      ].join("\n\n"),
    });
  });

  it("keeps assistant snapshots hidden unless explicitly enabled", () => {
    expect(
      buildChatStreamDebugLog(
        {
          type: "assistant_snapshot",
          assistantText: "Working...",
        },
        context
      )
    ).toBeUndefined();
  });

  it("formats stream errors for terminal output", () => {
    const event: ChatStreamEvent = {
      type: "error",
      error: "Skill execution failed.",
    };

    expect(buildChatStreamDebugLog(event, context)).toEqual({
      level: "error",
      text: [
        "Stream error · agent=debug-agent · session=session-123",
        "Error\nSkill execution failed.",
      ].join("\n\n"),
    });
  });
});

describe("loop and skill observability logs", () => {
  const context = {
    agentId: "debug-agent",
    sessionId: "session-123",
  };

  it("summarizes loop iterations with skill calls", () => {
    const message = buildLoopIterationDebugLog(context, {
      iteration: 2,
      assistantText:
        '<skill_call name="search-store">release notes</skill_call>',
      thinkingText: "Need the latest release notes.",
      skillCalls: [{ skillName: "search-store", input: "release notes" }],
    });

    expect(message.level).toBe("info");
    expect(message.text).toContain("Loop iteration 2");
    expect(message.text).toContain("search-store(release notes)");
    expect(message.text).toContain("Need the latest release notes.");
  });

  it("marks max-iteration exits as errors", () => {
    const message = buildLoopOutcomeDebugLog(context, {
      iteration: 5,
      outcome: "max-iterations",
    });

    expect(message.level).toBe("error");
    expect(message.text).toContain("Loop max-iterations");
  });

  it("records skill execution resolution details", () => {
    const message = buildSkillExecutionDebugLog(context, {
      durationMs: 42,
      iteration: 1,
      requestedSkillName: "search-store",
      resolved: true,
      result: {
        skillName: "search-store",
        output: "Found 2 notes.",
        exitCode: 0,
      },
    });

    expect(message.level).toBe("info");
    expect(message.text).toContain("Skill execution · search-store");
    expect(message.text).toContain("Duration\n42ms");
    expect(message.text).toContain("Resolved\nyes");
  });

  it("logs loaded skill inventory counts", () => {
    const message = buildSkillInventoryDebugLog(context, {
      executableSkillCount: 1,
      skillNames: ["search-store", "read-memory"],
    });

    expect(message.level).toBe("info");
    expect(message.text).toContain("Skill inventory");
    expect(message.text).toContain("Loaded\n2");
    expect(message.text).toContain("Executable\n1");
    expect(message.text).toContain("search-store, read-memory");
  });
});
