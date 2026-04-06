import { describe, expect, it, vi } from "vitest";
import { buildMessages, formatTime } from "./App";

describe("buildMessages", () => {
  it("appends a streaming assistant message when partial output exists", () => {
    const messages = buildMessages(
      {
        sessionId: "session-1",
        agentId: "release-planner",
        title: "Release planning",
        startedAt: "2026-04-06T21:00:00.000Z",
        summary: "Release planning",
        manifestPath: "agents/release-planner/history/session-1/SESSION.md",
        turnCount: 1,
        turns: [
          {
            messageId: "turn-1",
            sender: "user",
            createdAt: "2026-04-06T21:00:00.000Z",
            bodyMarkdown: "Outline the release checklist.",
            relativePath:
              "agents/release-planner/history/session-1/turns/2026-04-06-user.md",
          },
        ],
      },
      {
        sending: true,
        assistantText: "1. Run tests.",
        thinkingText: "Compare recent release regressions first.",
      }
    );

    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({
      key: "streaming-assistant",
      streaming: true,
      turn: {
        sender: "assistant",
        bodyMarkdown: "1. Run tests.",
        thinkingMarkdown: "Compare recent release regressions first.",
      },
    });
  });
});

describe("formatTime", () => {
  it("returns a placeholder when no timestamp is available", () => {
    expect(formatTime()).toBe("—");
  });

  it("formats timestamps with the user locale", () => {
    const localeSpy = vi.spyOn(Date.prototype, "toLocaleString");
    localeSpy.mockReturnValue("Apr 6, 9:00 PM");

    expect(formatTime("2026-04-06T21:00:00.000Z")).toBe("Apr 6, 9:00 PM");
    expect(localeSpy).toHaveBeenCalledOnce();
  });
});
