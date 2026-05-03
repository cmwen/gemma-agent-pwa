import {
  GEMMA_BALANCED_PRESET_ID,
  GEMMA_FAST_PRESET_ID,
} from "@gemma-agent-pwa/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyPresetRuntimeConfig,
  buildAppShellClassName,
  buildCompletionNotification,
  buildDetailPanelClassName,
  buildMessages,
  buildStreamConsoleEntry,
  filterCommandItems,
  formatNotificationPermissionLabel,
  formatTime,
  getNextFocusableIndex,
  getNotificationPermission,
  getPreferredTheme,
  isEditableElement,
  isNotificationSupported,
  shouldBlurActiveEditableElementOnPointerDown,
  shouldSendCompletionNotification,
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

  it("keeps a streaming assistant message visible for skill activity blocks", () => {
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
        skillActivities: [
          {
            id: "tool-1",
            skillInput: '{"scope":"mobile"}',
            skillName: "release-checklist",
          },
        ],
      }
    );

    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({
      key: "streaming-assistant",
      skillActivities: [
        {
          id: "tool-1",
          skillInput: '{"scope":"mobile"}',
          skillName: "release-checklist",
        },
      ],
      streaming: true,
      turn: {
        bodyMarkdown: "",
        sender: "assistant",
      },
    });
  });

  it("keeps the skill activity message visible after streaming finishes", () => {
    const messages = buildMessages(
      {
        sessionId: "session-1",
        agentId: "release-planner",
        title: "Release planning",
        startedAt: "2026-04-06T21:00:00.000Z",
        summary: "Release planning",
        manifestPath: "agents/release-planner/history/session-1/SESSION.md",
        turnCount: 2,
        turns: [
          {
            messageId: "turn-1",
            sender: "user",
            createdAt: "2026-04-06T21:00:00.000Z",
            bodyMarkdown: "Outline the release checklist.",
            relativePath:
              "agents/release-planner/history/session-1/turns/2026-04-06-user.md",
          },
          {
            messageId: "turn-2",
            sender: "assistant",
            createdAt: "2026-04-06T21:01:00.000Z",
            bodyMarkdown: "Release checklist ready.",
            relativePath:
              "agents/release-planner/history/session-1/turns/2026-04-06-assistant.md",
          },
        ],
      },
      {
        sending: false,
        skillActivities: [
          {
            exitCode: 0,
            id: "tool-1",
            skillInput: '{"scope":"mobile"}',
            skillName: "release-checklist",
            skillOutput: "Checklist drafted for mobile release.",
          },
        ],
      }
    );

    expect(messages).toHaveLength(3);
    expect(messages[2]).toMatchObject({
      key: "streaming-assistant",
      skillActivities: [
        {
          exitCode: 0,
          id: "tool-1",
          skillInput: '{"scope":"mobile"}',
          skillName: "release-checklist",
          skillOutput: "Checklist drafted for mobile release.",
        },
      ],
    });
    expect(messages[2]?.streaming).toBeUndefined();
  });
});

describe("desktop layout helpers", () => {
  it("drops the details column from the shell when the rail is closed", () => {
    expect(buildAppShellClassName(true)).toBe(
      "app-shell app-shell-details-open"
    );
    expect(buildAppShellClassName(false)).toBe(
      "app-shell app-shell-details-closed"
    );
  });

  it("marks the details rail as collapsed only when it should be hidden", () => {
    expect(buildDetailPanelClassName(true)).toBe(
      "panel detail-panel detail-panel-visible"
    );
    expect(buildDetailPanelClassName(false)).toBe(
      "panel detail-panel detail-panel-desktop-collapsed"
    );
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
          contextWindowSize: 32768,
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
      contextWindowSize: 32768,
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

describe("notification helpers", () => {
  it("reports browser notification support and permission", () => {
    const fakeNotification = {
      permission: "granted" as NotificationPermission,
    };

    vi.stubGlobal("Notification", fakeNotification);

    expect(isNotificationSupported()).toBe(true);
    expect(getNotificationPermission()).toBe("granted");
  });

  it("formats notification permissions for the UI", () => {
    expect(formatNotificationPermissionLabel("granted")).toBe("Allowed");
    expect(formatNotificationPermissionLabel("default")).toBe("Ask");
    expect(formatNotificationPermissionLabel("denied")).toBe("Blocked");
    expect(formatNotificationPermissionLabel("unsupported")).toBe(
      "Unsupported"
    );
  });

  it("only notifies when the app is backgrounded and permission is granted", () => {
    expect(
      shouldSendCompletionNotification({
        notificationsEnabled: true,
        permission: "granted",
        documentHidden: true,
        windowHasFocus: true,
      })
    ).toBe(true);
    expect(
      shouldSendCompletionNotification({
        notificationsEnabled: true,
        permission: "granted",
        documentHidden: false,
        windowHasFocus: true,
      })
    ).toBe(false);
    expect(
      shouldSendCompletionNotification({
        notificationsEnabled: true,
        permission: "default",
        documentHidden: true,
        windowHasFocus: false,
      })
    ).toBe(false);
  });

  it("builds concise completion notification copy", () => {
    expect(
      buildCompletionNotification({
        sessionId: "session-1",
        sessionTitle: "Release planning",
        assistantMarkdown:
          "## Checklist\n\n1. Run `pnpm test`\n2. Review the [deploy guide](https://example.com).",
      })
    ).toEqual({
      title: "Release planning ready",
      body: "Checklist 1. Run pnpm test 2. Review the deploy guide.",
      tag: "gemma-agent-pwa-session-session-1",
    });
  });
});

describe("mobile pointer helpers", () => {
  function stubPointerHelperGlobals() {
    class TestNode {
      children = new Set<TestNode>();
    }

    class TestElement extends TestNode {
      dataset: Record<string, string> = {};
      parentElement: TestElement | null = null;

      appendChild(child: TestNode) {
        this.children.add(child);
        if (child instanceof TestElement) {
          child.parentElement = this;
        }
      }

      contains(target: Node) {
        if (!(target instanceof TestNode)) {
          return false;
        }
        if (target === this) {
          return true;
        }
        for (const child of this.children) {
          if (child === target) {
            return true;
          }
          if (child instanceof TestElement && child.contains(target)) {
            return true;
          }
        }
        return false;
      }
    }

    class TestHTMLElement extends TestElement {
      isContentEditable = false;
    }

    class TestHTMLInputElement extends TestHTMLElement {}
    class TestHTMLTextAreaElement extends TestHTMLElement {}
    class TestHTMLSelectElement extends TestHTMLElement {}

    vi.stubGlobal("Node", TestNode);
    vi.stubGlobal("Element", TestElement);
    vi.stubGlobal("HTMLElement", TestHTMLElement);
    vi.stubGlobal("HTMLInputElement", TestHTMLInputElement);
    vi.stubGlobal("HTMLTextAreaElement", TestHTMLTextAreaElement);
    vi.stubGlobal("HTMLSelectElement", TestHTMLSelectElement);

    return {
      createDiv: () => new TestHTMLElement(),
      createInput: () => new TestHTMLInputElement(),
      createSelect: () => new TestHTMLSelectElement(),
      createSpan: () => new TestHTMLElement(),
      createTextarea: () => new TestHTMLTextAreaElement(),
    };
  }

  it("blurs the active mobile input when a touch lands outside editable controls", () => {
    const testDom = stubPointerHelperGlobals();
    const activeElement = testDom.createTextarea();
    const target = testDom.createDiv();

    expect(
      shouldBlurActiveEditableElementOnPointerDown({
        activeElement,
        desktopBreakpoint: 981,
        pointerType: "touch",
        target,
        viewportWidth: 480,
      })
    ).toBe(true);
  });

  it("keeps focus when the touch stays inside editable controls or on desktop", () => {
    const testDom = stubPointerHelperGlobals();
    const textarea = testDom.createTextarea();
    const nestedTarget = testDom.createSpan();
    textarea.appendChild(nestedTarget);

    expect(
      shouldBlurActiveEditableElementOnPointerDown({
        activeElement: textarea,
        desktopBreakpoint: 981,
        pointerType: "touch",
        target: nestedTarget,
        viewportWidth: 480,
      })
    ).toBe(false);

    expect(
      shouldBlurActiveEditableElementOnPointerDown({
        activeElement: textarea,
        desktopBreakpoint: 981,
        pointerType: "mouse",
        target: testDom.createDiv(),
        viewportWidth: 480,
      })
    ).toBe(false);

    expect(
      shouldBlurActiveEditableElementOnPointerDown({
        activeElement: textarea,
        desktopBreakpoint: 981,
        pointerType: "touch",
        target: testDom.createDiv(),
        viewportWidth: 1200,
      })
    ).toBe(false);
  });

  it("keeps focus when the touch starts inside a mobile scroll region", () => {
    const testDom = stubPointerHelperGlobals();
    const textarea = testDom.createTextarea();
    const scrollRegion = testDom.createDiv();
    scrollRegion.dataset.mobileScrollRegion = "true";
    const target = testDom.createSpan();
    scrollRegion.appendChild(target);

    expect(
      shouldBlurActiveEditableElementOnPointerDown({
        activeElement: textarea,
        desktopBreakpoint: 981,
        pointerType: "touch",
        target,
        viewportWidth: 480,
      })
    ).toBe(false);
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
      summary: "Skill call · search-store",
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
