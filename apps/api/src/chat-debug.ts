import type {
  ChatRuntimeConfig,
  ChatStreamEvent,
} from "@gemma-agent-pwa/contracts";
import type { SkillCallRequest, SkillCallResult } from "./agent-skills.js";

interface ChatDebugContext {
  agentId: string;
  sessionId: string;
}

interface ChatRequestDebugLogInput extends ChatDebugContext {
  prompt: string;
  runtimeConfig: ChatRuntimeConfig;
  title: string;
}

interface ChatDebugOptions {
  includeSnapshots?: boolean;
}

interface ChatDebugMessage {
  level: "info" | "error";
  text: string;
}

interface LoopIterationDebugInput {
  iteration: number;
  assistantText: string;
  thinkingText?: string;
  skillCalls: SkillCallRequest[];
}

interface LoopOutcomeDebugInput {
  iteration: number;
  outcome: "answered" | "max-iterations";
}

interface SkillExecutionDebugInput {
  durationMs: number;
  iteration: number;
  requestedSkillName: string;
  resolved: boolean;
  result: SkillCallResult;
}

interface SkillInventoryDebugInput {
  executableSkillCount: number;
  skillNames: string[];
}

const MAX_RESPONSE_PREVIEW_LENGTH = 1_200;

export function buildChatRequestDebugLog(
  input: ChatRequestDebugLogInput
): ChatDebugMessage {
  return {
    level: "info",
    text: buildMessage(
      `Request queued · ${formatContext(input)} · model=${input.runtimeConfig.model}`,
      [
        ["Title", input.title],
        ["Prompt", input.prompt],
        ["Config", JSON.stringify(input.runtimeConfig, null, 2)],
      ]
    ),
  };
}

export function buildChatStreamDebugLog(
  event: ChatStreamEvent,
  context: ChatDebugContext,
  options: ChatDebugOptions = {}
): ChatDebugMessage | undefined {
  switch (event.type) {
    case "thread":
      return {
        level: "info",
        text: buildMessage(`Session ready · ${formatContext(context)}`, [
          ["Title", event.thread.title],
        ]),
      };
    case "assistant_snapshot":
      if (!options.includeSnapshots) {
        return undefined;
      }
      return {
        level: "info",
        text: buildMessage(`Assistant snapshot · ${formatContext(context)}`, [
          ["Assistant", event.assistantText],
          ["Thinking", event.thinkingText],
        ]),
      };
    case "skill_call":
      return {
        level: "info",
        text: buildMessage(
          `Tool call · ${event.skillName} · ${formatContext(context)}`,
          [["Input", event.skillInput]]
        ),
      };
    case "skill_result":
      return {
        level: event.exitCode === 0 ? "info" : "error",
        text: buildMessage(
          `Tool result · ${event.skillName} · exit ${event.exitCode} · ${formatContext(context)}`,
          [["Output", event.skillOutput]]
        ),
      };
    case "complete":
      return {
        level: "info",
        text: buildMessage(`Response saved · ${formatContext(context)}`, [
          [
            "Assistant",
            truncateText(
              event.response.assistantTurn.bodyMarkdown,
              MAX_RESPONSE_PREVIEW_LENGTH
            ),
          ],
        ]),
      };
    case "error":
      return {
        level: "error",
        text: buildMessage(`Stream error · ${formatContext(context)}`, [
          ["Error", event.error],
        ]),
      };
  }
}

export function buildLoopIterationDebugLog(
  context: ChatDebugContext,
  input: LoopIterationDebugInput
): ChatDebugMessage {
  return {
    level: "info",
    text: buildMessage(
      `Loop iteration ${input.iteration} · ${formatContext(context)}`,
      [
        ["Skill calls", formatSkillCallSummary(input.skillCalls)],
        [
          "Assistant",
          truncateText(input.assistantText, MAX_RESPONSE_PREVIEW_LENGTH),
        ],
        [
          "Thinking",
          input.thinkingText
            ? truncateText(input.thinkingText, MAX_RESPONSE_PREVIEW_LENGTH)
            : undefined,
        ],
      ]
    ),
  };
}

export function buildLoopOutcomeDebugLog(
  context: ChatDebugContext,
  input: LoopOutcomeDebugInput
): ChatDebugMessage {
  return {
    level: input.outcome === "answered" ? "info" : "error",
    text: buildMessage(`Loop ${input.outcome} · ${formatContext(context)}`, [
      ["Iteration", String(input.iteration)],
    ]),
  };
}

export function buildSkillExecutionDebugLog(
  context: ChatDebugContext,
  input: SkillExecutionDebugInput
): ChatDebugMessage {
  return {
    level: input.result.exitCode === 0 ? "info" : "error",
    text: buildMessage(
      `Skill execution · ${input.requestedSkillName} · ${formatContext(context)}`,
      [
        ["Iteration", String(input.iteration)],
        ["Resolved", input.resolved ? "yes" : "no"],
        ["Duration", `${input.durationMs}ms`],
        ["Exit code", String(input.result.exitCode)],
        [
          "Output",
          truncateText(input.result.output, MAX_RESPONSE_PREVIEW_LENGTH),
        ],
      ]
    ),
  };
}

export function buildSkillInventoryDebugLog(
  context: ChatDebugContext,
  input: SkillInventoryDebugInput
): ChatDebugMessage {
  return {
    level: "info",
    text: buildMessage(`Skill inventory · ${formatContext(context)}`, [
      ["Loaded", String(input.skillNames.length)],
      ["Executable", String(input.executableSkillCount)],
      ["Skills", input.skillNames.join(", ")],
    ]),
  };
}

export function logChatDebugMessage(
  message: ChatDebugMessage | undefined
): void {
  if (!message || process.env.NODE_ENV === "test") {
    return;
  }

  const logger = message.level === "error" ? console.error : console.info;
  logger(`[chat] ${message.text}`);
}

function buildMessage(
  summary: string,
  sections: Array<[label: string, content: string | undefined]>
): string {
  const blocks = sections
    .map(([label, content]) => {
      const normalized = normalizeContent(content);
      if (!normalized) {
        return undefined;
      }

      return `${label}\n${normalized}`;
    })
    .filter((block): block is string => Boolean(block));

  return [summary, ...blocks].join("\n\n");
}

function formatContext(context: ChatDebugContext): string {
  return `agent=${context.agentId} · session=${context.sessionId}`;
}

function normalizeContent(content: string | undefined): string | undefined {
  if (content === undefined) {
    return undefined;
  }

  return content.length > 0 ? content : "(empty)";
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength)}\n...[truncated ${text.length - maxLength} chars]`;
}

function formatSkillCallSummary(skillCalls: SkillCallRequest[]): string {
  if (skillCalls.length === 0) {
    return "none";
  }

  return skillCalls
    .map((call) =>
      call.input.trim()
        ? `${call.skillName}(${truncateText(call.input, 120).replace(/\s+/g, " ")})`
        : call.skillName
    )
    .join(", ");
}
