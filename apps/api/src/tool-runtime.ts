import {
  type ChatTool,
  DELEGATION_TOOL_NAME,
} from "@gemma-agent-pwa/contracts";
import type { LoadedSkillDocument } from "@gemma-agent-pwa/min-kb-bridge";
import {
  createLoadSkillTool,
  executeLoadSkillTool,
  LOAD_SKILL_TOOL_NAME,
  type SkillCallRequest,
  type SkillCallResult,
} from "./agent-skills.js";

export function buildRuntimeTools(input: {
  enabledSkills: LoadedSkillDocument[];
  extraTools?: ChatTool[];
  delegationTool?: ChatTool;
}): ChatTool[] {
  const toolsByName = new Map<string, ChatTool>();

  for (const tool of input.extraTools ?? []) {
    toolsByName.set(tool.name, tool);
  }

  const loadSkillTool = createLoadSkillTool(input.enabledSkills);
  if (loadSkillTool) {
    toolsByName.set(loadSkillTool.name, loadSkillTool);
  }

  if (input.delegationTool) {
    toolsByName.set(input.delegationTool.name, input.delegationTool);
  }

  return [...toolsByName.values()];
}

export async function executeRuntimeToolCall(
  call: SkillCallRequest,
  input: {
    enabledSkills: LoadedSkillDocument[];
    executeDelegation?: (callInput: string) => Promise<SkillCallResult>;
  }
): Promise<SkillCallResult> {
  if (call.skillName === LOAD_SKILL_TOOL_NAME) {
    return executeLoadSkillTool(input.enabledSkills, call.input);
  }

  if (call.skillName === DELEGATION_TOOL_NAME) {
    if (input.executeDelegation) {
      return input.executeDelegation(call.input);
    }

    return {
      skillName: DELEGATION_TOOL_NAME,
      exitCode: 1,
      output: "Delegation tool is not configured in this runtime.",
    };
  }

  return {
    skillName: call.skillName,
    exitCode: 1,
    output: `Tool "${call.skillName}" is not available in this runtime.`,
  };
}
