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
