import {
  type ChatSession,
  type ChatTurn,
  getPresetById,
  type PartialChatRuntimeConfig,
} from "@gemma-agent-pwa/contracts";

interface StreamingStateSnapshot {
  sending: boolean;
  assistantText?: string;
  thinkingText?: string;
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

export function isEditableElement(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement)
  );
}
