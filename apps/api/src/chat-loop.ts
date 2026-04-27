import type {
  ChatRuntimeConfig,
  ChatStreamEvent,
  ChatTurn,
  LlmRequestStats,
} from "@gemma-agent-pwa/contracts";
import type { LoadedSkillDocument } from "@gemma-agent-pwa/min-kb-bridge";
import {
  executeSkillScript,
  parseSkillCalls,
  type SkillCallResult,
  stripSkillCalls,
} from "./agent-skills.js";
import {
  buildLoopIterationDebugLog,
  buildLoopOutcomeDebugLog,
  buildSkillExecutionDebugLog,
  logChatDebugMessage,
} from "./chat-debug.js";
import { streamLmStudioChat } from "./lmstudio.js";

const MAX_SKILL_LOOP_ITERATIONS = 5;
const FINALIZE_AFTER_SKILLS_INSTRUCTION =
  "Use the skill result above to answer the user's latest request directly. Do not include reasoning traces, planning notes, or raw tool-call markup in the visible reply.";

type StreamChatResult = Awaited<ReturnType<typeof streamLmStudioChat>>;
type StreamChat = typeof streamLmStudioChat;
type ExecuteSkill = typeof executeSkillScript;

interface ChatLoopOptions {
  agentId: string;
  agentPrompt: string | undefined;
  config: ChatRuntimeConfig;
  conversationTurns: ChatTurn[];
  enabledSkills: LoadedSkillDocument[];
  sessionId: string;
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

export async function runChatLoop(
  options: ChatLoopOptions
): Promise<ChatLoopResult> {
  const streamChat = options.streamChat ?? streamLmStudioChat;
  const executeSkill = options.executeSkill ?? executeSkillScript;
  const conversationTurns = [...options.conversationTurns];
  let finalAssistantText = "";
  let finalThinkingText: string | undefined;

  const totalLlmStats: LlmRequestStats = {
    recordedAt: new Date().toISOString(),
    model: options.config.model,
    requestCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    durationMs: 0,
  };

  for (
    let iteration = 0;
    iteration < MAX_SKILL_LOOP_ITERATIONS;
    iteration += 1
  ) {
    const result = await streamChat({
      model: options.config.model,
      config: options.config,
      conversation: conversationTurns,
      agentPrompt: options.agentPrompt,
      enabledSkills: options.enabledSkills,
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
      finalAssistantText = result.assistantText;
      finalThinkingText = result.thinkingText;
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

    const assistantTextWithoutCalls = stripSkillCalls(result.assistantText);
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
      await options.emitEvent?.({
        type: "skill_call",
        skillName: call.skillName,
        skillInput: call.input,
      });

      const skill = options.enabledSkills.find(
        (candidate) => candidate.name === call.skillName && candidate.hasScript
      );

      const startedAt = Date.now();
      const skillResult = skill
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
        skillName: skillResult.skillName,
        skillOutput: skillResult.output,
        exitCode: skillResult.exitCode,
      });

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

    if (iteration === MAX_SKILL_LOOP_ITERATIONS - 1) {
      finalAssistantText = assistantTextWithoutCalls || result.assistantText;
      finalThinkingText = result.thinkingText;
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

function updateLlmStats(
  totalLlmStats: LlmRequestStats,
  result: StreamChatResult
): void {
  totalLlmStats.requestCount += result.llmStats.requestCount;
  totalLlmStats.inputTokens += result.llmStats.inputTokens;
  totalLlmStats.outputTokens += result.llmStats.outputTokens;
  totalLlmStats.durationMs += result.llmStats.durationMs;
}

function unavailableSkillResult(skillName: string): SkillCallResult {
  return {
    skillName,
    output: `Skill "${skillName}" is not available or has no executable script.`,
    exitCode: 1,
  };
}

export const __testing = {
  FINALIZE_AFTER_SKILLS_INSTRUCTION,
  MAX_SKILL_LOOP_ITERATIONS,
  unavailableSkillResult,
  updateLlmStats,
};
