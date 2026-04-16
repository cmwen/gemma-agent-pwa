import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getAgentById } from "./agents.js";
import type { MinKbWorkspace } from "./workspace.js";

const createdRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    createdRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe("getAgentById", () => {
  it("normalizes legacy LM Studio runtime config aliases", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "gemma-agent-store-"));
    createdRoots.push(root);
    const workspace = createWorkspace(root);
    await createAgentFixture(workspace, {
      provider: "LM Studio",
      model: "google/gemma-3-4b",
      presetId: "gemma4-fast",
      lmStudioEnableThinking: false,
      maxCompletionTokens: 2048,
      temperature: 0.2,
      topP: 0.92,
      disabledSkills: ["legacy-skill"],
      reasoningEffort: "medium",
    });

    const agent = await getAgentById(workspace, "release-planner");
    expect(agent?.runtimeConfig).toEqual({
      provider: "lmstudio",
      model: "google/gemma-3-4b",
      presetId: "gemma4-fast",
      lmStudioEnableThinking: false,
      maxCompletionTokens: 2048,
      temperature: 0.2,
      topP: 0.92,
      disabledSkills: ["legacy-skill"],
    });
  });

  it("ignores unsupported legacy providers instead of throwing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "gemma-agent-store-"));
    createdRoots.push(root);
    const workspace = createWorkspace(root);
    await createAgentFixture(workspace, {
      provider: "copilot",
      model: "gpt-5",
      disabledSkills: [],
      reasoningEffort: "high",
    });

    const agent = await getAgentById(workspace, "release-planner");
    expect(agent?.runtimeConfig).toBeUndefined();
  });
});

function createWorkspace(storeRoot: string): MinKbWorkspace {
  return {
    storeRoot,
    agentsRoot: path.join(storeRoot, "agents"),
    memoryRoot: path.join(storeRoot, "memory"),
    skillsRoot: path.join(storeRoot, "skills"),
    copilotConfigDir: path.join(storeRoot, ".copilot"),
    copilotSkillsRoot: path.join(storeRoot, ".copilot", "skills"),
  };
}

async function createAgentFixture(
  workspace: MinKbWorkspace,
  runtimeConfig: Record<string, unknown>
): Promise<void> {
  const defaultRoot = path.join(workspace.agentsRoot, "default");
  const agentRoot = path.join(workspace.agentsRoot, "release-planner");
  await Promise.all([
    mkdir(defaultRoot, { recursive: true }),
    mkdir(agentRoot, { recursive: true }),
    mkdir(workspace.memoryRoot, { recursive: true }),
    mkdir(workspace.skillsRoot, { recursive: true }),
    mkdir(workspace.copilotSkillsRoot, { recursive: true }),
  ]);

  await Promise.all([
    writeFile(path.join(defaultRoot, "SOUL.md"), "Default soul.\n", "utf8"),
    writeFile(
      path.join(agentRoot, "AGENT.md"),
      "---\ntitle: Release Planner\n---\nPlan releases.\n",
      "utf8"
    ),
    writeFile(
      path.join(agentRoot, "RUNTIME.json"),
      `${JSON.stringify(runtimeConfig, null, 2)}\n`,
      "utf8"
    ),
  ]);
}
