import type { ChatRuntimeConfig } from "@gemma-agent-pwa/contracts";
import { getPresetById, mergeRuntimeConfig } from "@gemma-agent-pwa/contracts";
import type { MinKbWorkspace } from "@gemma-agent-pwa/min-kb-bridge";
import {
  getAgentById,
  recordSessionLlmUsage,
  saveChatTurn,
} from "@gemma-agent-pwa/min-kb-bridge";
import type { SkillCallRequest, SkillCallResult } from "./agent-skills.js";
import { loadAgentSkills } from "./agent-skills.js";
import { runChatLoop } from "./chat-loop.js";
import { listAvailableModels } from "./llm-provider.js";
import { buildRuntimeTools, executeRuntimeToolCall } from "./tool-runtime.js";

interface DelegationToolInput {
  agentId: string;
  prompt: string;
  title?: string;
}

export async function executeDelegatedAgentTool(
  workspace: MinKbWorkspace,
  input: {
    allowedAgentIds: string[];
    parentAgentId: string;
    parentSessionId: string;
    parentAgentTitle: string;
    parentConfig: ChatRuntimeConfig;
    executeToolCall?: (call: SkillCallRequest) => Promise<SkillCallResult>;
  },
  callInput: string
): Promise<SkillCallResult> {
  const parsedInput = parseDelegationToolInput(
    callInput,
    input.allowedAgentIds
  );
  if (!parsedInput) {
    return {
      skillName: "delegate-task",
      exitCode: 1,
      output:
        "Delegation requires a target agent and task prompt. Use JSON with agentId and prompt.",
    };
  }

  const targetAgent = await getAgentById(workspace, parsedInput.agentId);
  if (!targetAgent) {
    return {
      skillName: "delegate-task",
      exitCode: 1,
      output: `Delegated agent not found: ${parsedInput.agentId}`,
    };
  }

  if (!input.allowedAgentIds.includes(targetAgent.id)) {
    return {
      skillName: "delegate-task",
      exitCode: 1,
      output: `Delegation to ${targetAgent.id} is not allowed for ${input.parentAgentId}.`,
    };
  }

  const models = await listAvailableModels();
  const runtimeConfig = mergeRuntimeConfig(
    { model: chooseDefaultModel(models) ?? input.parentConfig.model },
    input.parentConfig,
    targetAgent.runtimeConfig
  );
  const sessionTitle =
    parsedInput.title?.trim() ||
    `${input.parentAgentTitle} · ${targetAgent.title}`.slice(0, 160);
  const userThread = await saveChatTurn(workspace, {
    agentId: targetAgent.id,
    sender: "user",
    bodyMarkdown: parsedInput.prompt,
    title: sessionTitle,
    runtimeConfig,
  });
  const enabledSkills = await loadAgentSkills(
    workspace,
    targetAgent.id,
    runtimeConfig.disabledSkills
  );
  const tools = buildRuntimeTools({
    enabledSkills,
  });
  const loopResult = await runChatLoop({
    agentId: targetAgent.id,
    agentKind: targetAgent.kind,
    agentPrompt: targetAgent.combinedPrompt,
    config: runtimeConfig,
    conversationTurns: userThread.turns,
    enabledSkills,
    tools,
    sessionId: userThread.sessionId,
    executeToolCall: (call) =>
      executeRuntimeToolCall(call, {
        enabledSkills,
      }),
  });
  const assistantSummary = summarizeThread(loopResult.assistantText);
  await saveChatTurn(workspace, {
    agentId: targetAgent.id,
    sender: "assistant",
    bodyMarkdown: loopResult.assistantText,
    thinkingMarkdown: loopResult.thinkingText,
    title: userThread.title,
    sessionId: userThread.sessionId,
    runtimeConfig,
    summary: assistantSummary,
  });
  await recordSessionLlmUsage(workspace, targetAgent.id, userThread.sessionId, {
    ...loopResult.llmStats,
    ...(loopResult.llmStats.outputTokens > 0 &&
    loopResult.llmStats.durationMs > 0
      ? {
          tokensPerSecond: Number(
            (
              (loopResult.llmStats.outputTokens /
                loopResult.llmStats.durationMs) *
              1000
            ).toFixed(2)
          ),
        }
      : {}),
  });

  return {
    skillName: "delegate-task",
    exitCode: 0,
    output: [
      `Delegated to ${targetAgent.id} in session ${userThread.sessionId} from parent session ${input.parentSessionId}.`,
      `Summary: ${assistantSummary}`,
      loopResult.assistantText.trim()
        ? `Result:\n${loopResult.assistantText.trim()}`
        : undefined,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n\n"),
  };
}

function parseDelegationToolInput(
  callInput: string,
  allowedAgentIds: string[]
): DelegationToolInput | undefined {
  const trimmed = callInput.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(trimmed) as Partial<DelegationToolInput>;
    const agentId =
      typeof parsed.agentId === "string" ? parsed.agentId.trim() : "";
    const prompt =
      typeof parsed.prompt === "string"
        ? parsed.prompt.trim()
        : typeof parsed.title === "string"
          ? parsed.title.trim()
          : "";
    if (!agentId || !prompt) {
      return undefined;
    }

    return {
      agentId,
      prompt,
      title:
        typeof parsed.title === "string" && parsed.title.trim()
          ? parsed.title.trim()
          : undefined,
    };
  } catch {
    if (allowedAgentIds.length === 1) {
      const [agentId] = allowedAgentIds;
      if (!agentId) {
        return undefined;
      }
      return {
        agentId,
        prompt: trimmed,
      };
    }

    return undefined;
  }
}

function summarizeThread(assistantText: string): string {
  const firstSentence = assistantText
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .find((sentence) => sentence.trim().length > 0);
  return firstSentence?.slice(0, 240) ?? getPresetById().description;
}

function chooseDefaultModel(
  models: Awaited<ReturnType<typeof listAvailableModels>>
): string | undefined {
  return (
    models.find((model) => /gemma-4/i.test(model.id))?.id ??
    models.find((model) => model.isGemma)?.id ??
    models[0]?.id
  );
}
