import os from "node:os";
import path from "node:path";
import type { WorkspaceSummary } from "@gemma-agent-pwa/contracts";
import { pathExists } from "./utils.js";

export interface ResolveWorkspaceOptions {
  storeRoot?: string;
  copilotConfigDir?: string;
}

export interface MinKbWorkspace {
  storeRoot: string;
  agentsRoot: string;
  memoryRoot: string;
  skillsRoot: string;
  copilotConfigDir: string;
  copilotSkillsRoot: string;
}

export async function resolveWorkspace(
  options: ResolveWorkspaceOptions = {}
): Promise<MinKbWorkspace> {
  const storeRoot = await resolveStoreRoot(options.storeRoot);
  const copilotConfigDir = path.resolve(
    options.copilotConfigDir ?? path.join(os.homedir(), ".copilot")
  );

  return {
    storeRoot,
    agentsRoot: path.join(storeRoot, "agents"),
    memoryRoot: path.join(storeRoot, "memory"),
    skillsRoot: path.join(storeRoot, "skills"),
    copilotConfigDir,
    copilotSkillsRoot: path.join(copilotConfigDir, "skills"),
  };
}

export async function summarizeWorkspace(
  workspace: MinKbWorkspace
): Promise<WorkspaceSummary> {
  const { pathExists } = await import("./utils.js");
  const { readDirNames } = await import("./utils.js");
  const agentNames = (await pathExists(workspace.agentsRoot))
    ? await readDirNames(workspace.agentsRoot)
    : [];

  return {
    storeRoot: workspace.storeRoot,
    copilotConfigDir: workspace.copilotConfigDir,
    storeSkillDirectory: workspace.skillsRoot,
    copilotSkillDirectory: workspace.copilotSkillsRoot,
    agentCount: agentNames.filter((name) => name !== "default").length,
  };
}

async function resolveStoreRoot(explicitRoot?: string): Promise<string> {
  const candidates = [
    explicitRoot,
    process.env.MIN_KB_STORE_ROOT,
    path.resolve(process.cwd(), "../min-kb-store"),
    path.resolve(process.cwd(), "min-kb-store"),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    const resolvedCandidate = path.resolve(candidate);
    const hasAgents = await pathExists(path.join(resolvedCandidate, "agents"));
    const hasMemory = await pathExists(path.join(resolvedCandidate, "memory"));
    const hasSkills = await pathExists(path.join(resolvedCandidate, "skills"));

    if (hasAgents && hasMemory && hasSkills) {
      return resolvedCandidate;
    }
  }

  throw new Error(
    [
      "Could not resolve a valid min-kb-store root.",
      "Set MIN_KB_STORE_ROOT or pass a store root explicitly.",
      `Checked candidates: ${candidates.join(", ") || "<none>"}`,
    ].join(" ")
  );
}
