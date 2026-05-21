import type {
  AgentSummary,
  ChatRuntimeConfig,
  ChatStreamEvent,
  ChatTool,
  ChatTurn,
  LlmRequestStats,
} from "@gemma-agent-pwa/contracts";
import {
  DELEGATION_TOOL_NAME,
  normalizeLlmRequestStats,
} from "@gemma-agent-pwa/contracts";
import type { LoadedSkillDocument } from "@gemma-agent-pwa/min-kb-bridge";
import {
  executeSkillScript,
  parseSkillCalls,
  type SkillCallRequest,
  type SkillCallResult,
  stripSkillCalls,
} from "./agent-skills.js";
import {
  buildLoopIterationDebugLog,
  buildLoopOutcomeDebugLog,
  buildSkillExecutionDebugLog,
  logChatDebugMessage,
} from "./chat-debug.js";
import { streamProviderChat } from "./llm-provider.js";

const DEFAULT_MAX_SKILL_LOOP_ITERATIONS = 5;
const FINALIZE_AFTER_SKILLS_INSTRUCTION =
  "Use the skill result above to continue solving the user's latest request. If you have enough information, answer the user directly in plain language. If you still need another executable skill, emit the next skill_call block(s) only. Do not include reasoning traces, planning notes, or raw tool-call markup in the visible reply.";

type StreamChatResult = Awaited<ReturnType<typeof streamProviderChat>>;
type StreamChat = typeof streamProviderChat;
type ExecuteSkill = typeof executeSkillScript;

interface ChatLoopOptions {
  agentId: string;
  agentKind?: AgentSummary["kind"];
  agentPrompt: string | undefined;
  config: ChatRuntimeConfig;
  conversationTurns: ChatTurn[];
  enabledSkills: LoadedSkillDocument[];
  tools?: ChatTool[];
  sessionId: string;
  executeToolCall?: (call: SkillCallRequest) => Promise<SkillCallResult>;
  emitEvent?: (
    event: Extract<
      ChatStreamEvent,
      { type: "assistant_snapshot" | "skill_call" | "skill_result" }
    >
  ) => Promise<void> | void;
  streamChat?: StreamChat;
  executeSkill?: ExecuteSkill;
}

interface ChatLoopResult {
  assistantText: string;
  thinkingText?: string;
  conversationTurns: ChatTurn[];
  llmStats: LlmRequestStats;
}

interface AssistantFallback {
  assistantText: string;
  thinkingText?: string;
}

export async function runChatLoop(
  options: ChatLoopOptions
): Promise<ChatLoopResult> {
  const streamChat = options.streamChat ?? streamProviderChat;
  const executeSkill = options.executeSkill ?? executeSkillScript;
  const conversationTurns = [...options.conversationTurns];
  const maxSkillLoopIterations = getMaxSkillLoopIterations();
  let finalAssistantText = "";
  let finalThinkingText: string | undefined;
  let latestAssistantFallback: AssistantFallback | undefined;

  const totalLlmStats: LlmRequestStats = {
    recordedAt: new Date().toISOString(),
    model: options.config.model,
    requestCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    durationMs: 0,
  };

  for (let iteration = 0; iteration < maxSkillLoopIterations; iteration += 1) {
    const result = await streamChat({
      model: options.config.model,
      config: options.config,
      conversation: conversationTurns,
      agentPrompt: options.agentPrompt,
      enabledSkills: options.enabledSkills,
      tools: options.tools ?? [],
      onSnapshot: (snapshot) =>
        Promise.resolve(
          options.emitEvent?.({
            type: "assistant_snapshot",
            ...snapshot,
          })
        ),
    });

    updateLlmStats(totalLlmStats, result);

    const skillCalls = parseSkillCalls(result.assistantText);
    const assistantTextWithoutCalls = stripSkillCalls(result.assistantText);
    logChatDebugMessage(
      buildLoopIterationDebugLog(
        {
          agentId: options.agentId,
          sessionId: options.sessionId,
        },
        {
          iteration: iteration + 1,
          assistantText: result.assistantText,
          thinkingText: result.thinkingText,
          skillCalls,
        }
      )
    );

    if (skillCalls.length === 0) {
      finalAssistantText =
        assistantTextWithoutCalls ||
        latestAssistantFallback?.assistantText ||
        "";
      finalThinkingText =
        result.thinkingText ?? latestAssistantFallback?.thinkingText;
      logChatDebugMessage(
        buildLoopOutcomeDebugLog(
          {
            agentId: options.agentId,
            sessionId: options.sessionId,
          },
          {
            iteration: iteration + 1,
            outcome: "answered",
          }
        )
      );
      break;
    }

    await options.emitEvent?.({
      type: "assistant_snapshot",
    });

    if (assistantTextWithoutCalls) {
      conversationTurns.push({
        messageId: `loop-assistant-${iteration}`,
        sender: "assistant",
        createdAt: new Date().toISOString(),
        bodyMarkdown: assistantTextWithoutCalls,
        relativePath: "in-flight",
      });
    }

    for (const call of skillCalls) {
      const skillCallId = buildSkillCallId(iteration, call.skillName);
      await options.emitEvent?.({
        type: "skill_call",
        skillCallId,
        skillName: call.skillName,
        skillInput: call.input,
      });

      const skill = options.enabledSkills.find(
        (candidate) => candidate.name === call.skillName && candidate.hasScript
      );
      const tool = (options.tools ?? []).find(
        (candidate) => candidate.name === call.skillName
      );

      const startedAt = Date.now();
      const skillResult =
        tool && options.executeToolCall
          ? await options.executeToolCall(call)
          : tool
            ? unavailableToolResult(call.skillName)
            : call.skillName === DELEGATION_TOOL_NAME
              ? unavailableDelegationToolResult()
              : skill
                ? await executeSkill(skill, call.input)
                : unavailableSkillResult(call.skillName);
      logChatDebugMessage(
        buildSkillExecutionDebugLog(
          {
            agentId: options.agentId,
            sessionId: options.sessionId,
          },
          {
            durationMs: Date.now() - startedAt,
            iteration: iteration + 1,
            requestedSkillName: call.skillName,
            result: skillResult,
            resolved: Boolean(skill),
          }
        )
      );

      await options.emitEvent?.({
        type: "skill_result",
        skillCallId,
        skillName: skillResult.skillName,
        skillOutput: skillResult.output,
        exitCode: skillResult.exitCode,
      });

      latestAssistantFallback = buildAssistantFallback(
        latestAssistantFallback,
        skillResult
      );

      conversationTurns.push({
        messageId: `loop-tool-${iteration}-${call.skillName}`,
        sender: "tool",
        createdAt: new Date().toISOString(),
        bodyMarkdown: `[Skill result: ${call.skillName} (exit code ${skillResult.exitCode})]\n\n${skillResult.output}`,
        relativePath: "in-flight",
      });
    }

    conversationTurns.push({
      messageId: `loop-system-${iteration}`,
      sender: "system",
      createdAt: new Date().toISOString(),
      bodyMarkdown: FINALIZE_AFTER_SKILLS_INSTRUCTION,
      relativePath: "in-flight",
    });

    if (iteration === maxSkillLoopIterations - 1) {
      finalAssistantText =
        assistantTextWithoutCalls ||
        latestAssistantFallback?.assistantText ||
        "";
      finalThinkingText =
        result.thinkingText ?? latestAssistantFallback?.thinkingText;
      logChatDebugMessage(
        buildLoopOutcomeDebugLog(
          {
            agentId: options.agentId,
            sessionId: options.sessionId,
          },
          {
            iteration: iteration + 1,
            outcome: "max-iterations",
          }
        )
      );
    }
  }

  if (!finalAssistantText) {
    throw new Error("LM Studio returned no assistant message content.");
  }

  return {
    assistantText: finalAssistantText,
    ...(finalThinkingText ? { thinkingText: finalThinkingText } : {}),
    conversationTurns,
    llmStats: totalLlmStats,
  };
}

function getMaxSkillLoopIterations(): number {
  return DEFAULT_MAX_SKILL_LOOP_ITERATIONS;
}

function updateLlmStats(
  totalLlmStats: LlmRequestStats,
  result: StreamChatResult
): void {
  const normalizedResultStats = normalizeLlmRequestStats(result.llmStats);
  totalLlmStats.requestCount += normalizedResultStats.requestCount;
  totalLlmStats.inputTokens += normalizedResultStats.inputTokens;
  totalLlmStats.outputTokens += normalizedResultStats.outputTokens;
  totalLlmStats.durationMs += normalizedResultStats.durationMs;
}

function unavailableSkillResult(skillName: string): SkillCallResult {
  return {
    skillName,
    output: `Skill "${skillName}" is not available or has no executable script.`,
    exitCode: 1,
  };
}

function unavailableDelegationToolResult(): SkillCallResult {
  return {
    skillName: DELEGATION_TOOL_NAME,
    output: "Delegation tool is not configured in this runtime.",
    exitCode: 1,
  };
}

function unavailableToolResult(toolName: string): SkillCallResult {
  return {
    skillName: toolName,
    output: `Tool "${toolName}" is not available in this runtime.`,
    exitCode: 1,
  };
}

function buildSkillCallId(iteration: number, skillName: string): string {
  return `skill-call-${iteration + 1}-${skillName}`;
}

function buildAssistantFallback(
  current: AssistantFallback | undefined,
  skillResult: SkillCallResult
): AssistantFallback | undefined {
  const assistantText = skillResult.output.trim();
  if (assistantText) {
    return { assistantText };
  }

  if (current) {
    return current;
  }

  return {
    assistantText: `Tool "${skillResult.skillName}" completed with exit code ${skillResult.exitCode}.`,
  };
}

export const __testing = {
  DEFAULT_MAX_SKILL_LOOP_ITERATIONS,
  FINALIZE_AFTER_SKILLS_INSTRUCTION,
  buildAssistantFallback,
  buildSkillCallId,
  getMaxSkillLoopIterations,
  unavailableSkillResult,
  unavailableToolResult,
  updateLlmStats,
};
