import {
  GEMMA_BALANCED_PRESET_ID,
  GEMMA_FAST_PRESET_ID,
} from "@gemma-agent-pwa/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyPresetRuntimeConfig,
  buildMessages,
  buildStreamConsoleEntry,
  filterCommandItems,
  formatTime,
  getNextFocusableIndex,
  getPreferredTheme,
  isEditableElement,
} from "./app-utils";

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

  it("hides the streaming assistant message when skill activity clears partial output", () => {
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
      }
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]?.turn.sender).toBe("user");
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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

describe("applyPresetRuntimeConfig", () => {
  it("applies the selected preset defaults over previous runtime overrides", () => {
    expect(
      applyPresetRuntimeConfig(
        {
          model: "google/gemma-4b-it",
          presetId: GEMMA_BALANCED_PRESET_ID,
          lmStudioEnableThinking: true,
          maxCompletionTokens: 4096,
          temperature: 0.2,
          topP: 0.95,
        },
        GEMMA_FAST_PRESET_ID
      )
    ).toMatchObject({
      model: "google/gemma-4b-it",
      presetId: GEMMA_FAST_PRESET_ID,
      lmStudioEnableThinking: false,
      maxCompletionTokens: 2048,
      temperature: 0.2,
      topP: 0.92,
    });
  });
});

describe("getPreferredTheme", () => {
  it("returns light when the browser prefers a light color scheme", () => {
    const matchMedia = vi.fn().mockReturnValue({ matches: true });
    vi.stubGlobal("window", { matchMedia });

    expect(getPreferredTheme()).toBe("light");
    expect(matchMedia).toHaveBeenCalledWith("(prefers-color-scheme: light)");
  });

  it("falls back to dark when no light preference is reported", () => {
    vi.stubGlobal("window", {
      matchMedia: vi.fn().mockReturnValue({ matches: false }),
    });

    expect(getPreferredTheme()).toBe("dark");
  });
});

describe("filterCommandItems", () => {
  const commands = [
    {
      label: "Go to chat",
      description: "Focus the active conversation and composer.",
      keywords: ["chat", "composer", "conversation"],
    },
    {
      label: "Show agent details",
      description: "Toggle the full agent detail rail, including console logs.",
      keywords: ["agent", "details", "model", "status", "console", "settings"],
    },
  ];

  it("returns all commands for a blank query", () => {
    expect(filterCommandItems(commands, "")).toEqual(commands);
  });

  it("matches commands across labels, descriptions, and keywords", () => {
    expect(filterCommandItems(commands, "composer")).toEqual([commands[0]]);
    expect(filterCommandItems(commands, "console logs")).toEqual([commands[1]]);
    expect(filterCommandItems(commands, "settings")).toEqual([commands[1]]);
  });
});

describe("buildStreamConsoleEntry", () => {
  it("formats tool call events for the agent console", () => {
    expect(
      buildStreamConsoleEntry(
        {
          type: "skill_call",
          skillName: "search-store",
          skillInput: "release notes",
        },
        "2026-04-27T05:00:00.000Z"
      )
    ).toEqual({
      id: "2026-04-27T05:00:00.000Z-skill-call-search-store",
      summary: "Tool call · search-store",
      detail: "release notes",
      timestamp: "2026-04-27T05:00:00.000Z",
      tone: "info",
    });
  });

  it("ignores assistant snapshots so the console stays compact", () => {
    expect(
      buildStreamConsoleEntry({
        type: "assistant_snapshot",
        assistantText: "Working...",
      })
    ).toBeUndefined();
  });
});

describe("getNextFocusableIndex", () => {
  it("cycles through vertical lists with arrow keys", () => {
    expect(getNextFocusableIndex(0, 3, "ArrowDown", "vertical")).toBe(1);
    expect(getNextFocusableIndex(2, 3, "ArrowDown", "vertical")).toBe(0);
    expect(getNextFocusableIndex(0, 3, "ArrowUp", "vertical")).toBe(2);
  });

  it("supports home and end navigation", () => {
    expect(getNextFocusableIndex(1, 4, "Home", "horizontal")).toBe(0);
    expect(getNextFocusableIndex(1, 4, "End", "horizontal")).toBe(3);
  });
});

describe("isEditableElement", () => {
  it("recognizes form fields as editable targets", () => {
    class FakeElement {}
    class FakeInput extends FakeElement {}
    class FakeTextArea extends FakeElement {}
    class FakeSelect extends FakeElement {}
    class FakeButton extends FakeElement {}

    vi.stubGlobal("HTMLElement", FakeElement);
    vi.stubGlobal("HTMLInputElement", FakeInput);
    vi.stubGlobal("HTMLTextAreaElement", FakeTextArea);
    vi.stubGlobal("HTMLSelectElement", FakeSelect);

    expect(isEditableElement(new FakeTextArea())).toBe(true);
    expect(isEditableElement(new FakeSelect())).toBe(true);
    expect(isEditableElement(new FakeButton())).toBe(false);
  });
});
