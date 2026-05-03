import { EventType } from "@ag-ui/core";
import type { ChatStreamEvent } from "@gemma-agent-pwa/contracts";

const GEMMA_SKILL_RESULT_EVENT = "gemma-skill-result";
const COMPLETE_SKILL_CALL_BLOCKS = [
  /<skill_call\s+name="[^"]+">[\s\S]*?<\/skill_call>/g,
  /<\|tool_call>\s*call(?:\s*:\s*|\s+)[A-Za-z0-9_.-]+[\s\S]*?(?:<\|tool_call\|>|<tool_call\|>|<\/tool_call>)/g,
];
const PARTIAL_SKILL_CALL_MARKERS = [
  "<skill_call",
  "<|tool_call>",
  "<tool_call",
];

export function createAgUiEventMapper(options: {
  emitEvent: (event: unknown) => Promise<void>;
  runId: string;
  threadId: string;
}) {
  let assistantMessageId: string | undefined;
  let assistantText = "";
  let reasoningMessageId: string | undefined;
  let reasoningText = "";
  const pendingToolCallIds: string[] = [];

  return {
    async apply(
      event: Extract<
        ChatStreamEvent,
        { type: "assistant_snapshot" | "skill_call" | "skill_result" }
      >
    ) {
      switch (event.type) {
        case "assistant_snapshot":
          if (!event.assistantText && !event.thinkingText) {
            await closeOpenMessages();
            return;
          }
          await emitReasoningDelta(event.thinkingText);
          await emitAssistantDelta(
            sanitizeVisibleAssistantText(event.assistantText)
          );
          return;
        case "skill_call": {
          await closeOpenMessages();
          const toolCallId = event.skillCallId ?? nextId("tool-call");
          pendingToolCallIds.push(toolCallId);
          await options.emitEvent({
            type: EventType.TOOL_CALL_START,
            toolCallId,
            toolCallName: event.skillName,
          });
          if (event.skillInput) {
            await options.emitEvent({
              type: EventType.TOOL_CALL_ARGS,
              delta: event.skillInput,
              toolCallId,
            });
          }
          await options.emitEvent({
            type: EventType.TOOL_CALL_END,
            toolCallId,
          });
          return;
        }
        case "skill_result": {
          const toolCallId =
            consumePendingToolCallId(event.skillCallId) ?? nextId("tool-call");
          await options.emitEvent({
            type: EventType.CUSTOM,
            name: GEMMA_SKILL_RESULT_EVENT,
            value: {
              exitCode: event.exitCode,
              toolCallId,
            },
          });
          await options.emitEvent({
            type: EventType.TOOL_CALL_RESULT,
            content: event.skillOutput,
            messageId: nextId("tool-result"),
            toolCallId,
          });
        }
      }
    },
    async fail(message: string) {
      await closeOpenMessages();
      await options.emitEvent({
        type: EventType.RUN_ERROR,
        message,
      });
    },
    async finish() {
      await closeOpenMessages();
      await options.emitEvent({
        type: EventType.RUN_FINISHED,
        outcome: {
          type: "success",
        },
        runId: options.runId,
        threadId: options.threadId,
      });
    },
    async start() {
      await options.emitEvent({
        type: EventType.RUN_STARTED,
        runId: options.runId,
        threadId: options.threadId,
      });
    },
  };

  async function closeOpenMessages() {
    if (reasoningMessageId) {
      await options.emitEvent({
        type: EventType.REASONING_MESSAGE_END,
        messageId: reasoningMessageId,
      });
      await options.emitEvent({
        type: EventType.REASONING_END,
        messageId: reasoningMessageId,
      });
      reasoningMessageId = undefined;
      reasoningText = "";
    }

    if (assistantMessageId) {
      await options.emitEvent({
        type: EventType.TEXT_MESSAGE_END,
        messageId: assistantMessageId,
      });
      assistantMessageId = undefined;
      assistantText = "";
    }
  }

  function consumePendingToolCallId(skillCallId: string | undefined) {
    if (skillCallId) {
      const matchIndex = pendingToolCallIds.indexOf(skillCallId);
      if (matchIndex >= 0) {
        pendingToolCallIds.splice(matchIndex, 1);
      }
      return skillCallId;
    }

    return pendingToolCallIds.shift();
  }

  async function emitAssistantDelta(nextText: string | undefined) {
    const delta = computeDelta(assistantText, nextText);
    if (!delta) {
      return;
    }

    if (!assistantMessageId) {
      assistantMessageId = nextId("assistant");
      await options.emitEvent({
        type: EventType.TEXT_MESSAGE_START,
        messageId: assistantMessageId,
        role: "assistant",
      });
    }

    assistantText = nextText ?? "";
    await options.emitEvent({
      type: EventType.TEXT_MESSAGE_CONTENT,
      delta,
      messageId: assistantMessageId,
    });
  }

  async function emitReasoningDelta(nextText: string | undefined) {
    const delta = computeDelta(reasoningText, nextText);
    if (!delta) {
      return;
    }

    if (!reasoningMessageId) {
      reasoningMessageId = nextId("reasoning");
      await options.emitEvent({
        type: EventType.REASONING_START,
        messageId: reasoningMessageId,
      });
      await options.emitEvent({
        type: EventType.REASONING_MESSAGE_START,
        messageId: reasoningMessageId,
        role: "reasoning",
      });
    }

    reasoningText = nextText ?? "";
    await options.emitEvent({
      type: EventType.REASONING_MESSAGE_CONTENT,
      delta,
      messageId: reasoningMessageId,
    });
  }
}

function computeDelta(previous: string, next: string | undefined): string {
  if (!next || next === previous) {
    return "";
  }

  if (next.startsWith(previous)) {
    return next.slice(previous.length);
  }

  const maxOverlap = Math.min(previous.length, next.length);
  for (let size = maxOverlap; size > 0; size -= 1) {
    if (previous.slice(-size) === next.slice(0, size)) {
      return next.slice(size);
    }
  }

  return next;
}

function sanitizeVisibleAssistantText(
  text: string | undefined
): string | undefined {
  if (text === undefined) {
    return undefined;
  }

  let sanitized = text;

  for (const pattern of COMPLETE_SKILL_CALL_BLOCKS) {
    sanitized = sanitized.replace(pattern, "");
  }

  const firstPartialIndex = PARTIAL_SKILL_CALL_MARKERS.reduce<number>(
    (currentIndex, marker) => {
      const markerIndex = sanitized.indexOf(marker);
      if (markerIndex < 0) {
        return currentIndex;
      }
      return currentIndex < 0
        ? markerIndex
        : Math.min(currentIndex, markerIndex);
    },
    -1
  );

  return firstPartialIndex >= 0
    ? sanitized.slice(0, firstPartialIndex)
    : sanitized;
}

function nextId(prefix: string): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) {
    return `${prefix}-${uuid}`;
  }

  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export const __testing = {
  computeDelta,
  sanitizeVisibleAssistantText,
};
