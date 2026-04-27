import {
  type ChatSession,
  type ChatStreamEvent,
  type ChatTurn,
  getPresetById,
  type PartialChatRuntimeConfig,
} from "@gemma-agent-pwa/contracts";

interface StreamingStateSnapshot {
  sending: boolean;
  assistantText?: string;
  thinkingText?: string;
}

export interface CommandSearchableItem {
  label: string;
  description: string;
  keywords: string[];
}

export interface StreamConsoleEntry {
  id: string;
  detail?: string;
  summary: string;
  timestamp: string;
  tone: "info" | "success" | "error";
}

export type ThemeMode = "light" | "dark";
export type FocusNavigationOrientation = "horizontal" | "vertical";

export function buildMessages(
  thread: ChatSession | undefined,
  streaming: StreamingStateSnapshot
): Array<{ key: string; turn: ChatTurn; streaming?: boolean }> {
  const turns = (thread?.turns ?? []).map((turn) => ({
    key: turn.messageId,
    turn,
  }));
  if (
    !streaming.sending ||
    (!streaming.assistantText && !streaming.thinkingText)
  ) {
    return turns;
  }
  return [
    ...turns,
    {
      key: "streaming-assistant",
      streaming: true,
      turn: {
        messageId: "streaming-assistant",
        sender: "assistant",
        createdAt: new Date().toISOString(),
        bodyMarkdown: streaming.assistantText ?? "",
        relativePath: "",
        ...(streaming.thinkingText
          ? { thinkingMarkdown: streaming.thinkingText }
          : {}),
      },
    },
  ];
}

export function buildAppShellClassName(modelDetailsOpen: boolean): string {
  return `app-shell ${
    modelDetailsOpen ? "app-shell-details-open" : "app-shell-details-closed"
  }`;
}

export function buildDetailPanelClassName(modelDetailsOpen: boolean): string {
  return `panel detail-panel ${
    modelDetailsOpen ? "detail-panel-visible" : "detail-panel-desktop-collapsed"
  }`;
}

export function formatTime(timestamp?: string): string {
  if (!timestamp) {
    return "—";
  }
  return new Date(timestamp).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function applyPresetRuntimeConfig(
  current: PartialChatRuntimeConfig,
  presetId: string
): PartialChatRuntimeConfig {
  const preset = getPresetById(presetId);
  return {
    ...current,
    presetId: preset.id,
    lmStudioEnableThinking: preset.lmStudioEnableThinking,
    maxCompletionTokens: preset.maxCompletionTokens,
    contextWindowSize: preset.contextWindowSize,
    temperature: preset.temperature,
    topP: preset.topP,
  };
}

export function getPreferredTheme(): ThemeMode {
  if (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: light)").matches
  ) {
    return "light";
  }
  return "dark";
}

export function getNextTheme(current: ThemeMode): ThemeMode {
  return current === "dark" ? "light" : "dark";
}

export function filterCommandItems<T extends CommandSearchableItem>(
  commands: T[],
  query: string
): T[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return commands;
  }
  return commands.filter((command) =>
    [command.label, command.description, ...command.keywords]
      .join(" ")
      .toLowerCase()
      .includes(normalizedQuery)
  );
}

export function getNextFocusableIndex(
  currentIndex: number,
  totalItems: number,
  key: string,
  orientation: FocusNavigationOrientation
): number | undefined {
  if (totalItems < 1) {
    return undefined;
  }

  if (key === "Home") {
    return 0;
  }
  if (key === "End") {
    return totalItems - 1;
  }

  const previousKey = orientation === "horizontal" ? "ArrowLeft" : "ArrowUp";
  const nextKey = orientation === "horizontal" ? "ArrowRight" : "ArrowDown";

  if (key === previousKey) {
    return currentIndex <= 0 ? totalItems - 1 : currentIndex - 1;
  }
  if (key === nextKey) {
    return currentIndex < 0 || currentIndex === totalItems - 1
      ? 0
      : currentIndex + 1;
  }

  return undefined;
}

export function buildStreamConsoleEntry(
  event: ChatStreamEvent,
  timestamp = new Date().toISOString()
): StreamConsoleEntry | undefined {
  switch (event.type) {
    case "thread":
      return {
        id: `${timestamp}-thread`,
        summary: "Request queued",
        detail: event.thread.title,
        timestamp,
        tone: "info",
      };
    case "assistant_snapshot":
      return undefined;
    case "skill_call":
      return {
        id: `${timestamp}-skill-call-${event.skillName}`,
        summary: `Tool call · ${event.skillName}`,
        detail: event.skillInput,
        timestamp,
        tone: "info",
      };
    case "skill_result":
      return {
        id: `${timestamp}-skill-result-${event.skillName}`,
        summary: `Tool result · ${event.skillName} (exit ${event.exitCode})`,
        detail: event.skillOutput,
        timestamp,
        tone: event.exitCode === 0 ? "success" : "error",
      };
    case "complete":
      return {
        id: `${timestamp}-complete`,
        summary: "Response saved",
        detail: event.response.assistantTurn.bodyMarkdown,
        timestamp,
        tone: "success",
      };
    case "error":
      return {
        id: `${timestamp}-error`,
        summary: "Stream error",
        detail: event.error,
        timestamp,
        tone: "error",
      };
  }
}

export function isEditableElement(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement)
  );
}
