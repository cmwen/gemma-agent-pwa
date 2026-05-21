import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getAgentById,
  listSkillsForAgent,
  loadEnabledSkillDocumentsForAgent,
} from "./agents.js";
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
      contextWindowSize: 8192,
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
      contextWindowSize: 8192,
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

  it("keeps SOUL and AGENT frontmatter out of the combined prompt", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "gemma-agent-store-"));
    createdRoots.push(root);
    const workspace = createWorkspace(root);
    const defaultRoot = path.join(workspace.agentsRoot, "default");
    const agentRoot = path.join(workspace.agentsRoot, "release-planner");

    await Promise.all([
      mkdir(defaultRoot, { recursive: true }),
      mkdir(agentRoot, { recursive: true }),
      mkdir(path.join(workspace.agentsRoot, "release-tasker"), {
        recursive: true,
      }),
      mkdir(path.join(workspace.agentsRoot, "qa-tasker"), { recursive: true }),
      mkdir(workspace.memoryRoot, { recursive: true }),
      mkdir(workspace.skillsRoot, { recursive: true }),
      mkdir(workspace.copilotSkillsRoot, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(
        path.join(defaultRoot, "SOUL.md"),
        "---\nowner: hidden\n---\nBe calm and pragmatic.\n",
        "utf8"
      ),
      writeFile(
        path.join(agentRoot, "AGENT.md"),
        "---\ntitle: Release Planner\nmetadata: hidden\n---\nPlan releases with concrete milestones.\n",
        "utf8"
      ),
    ]);

    const agent = await getAgentById(workspace, "release-planner");

    expect(agent?.combinedPrompt).toContain("Be calm and pragmatic.");
    expect(agent?.combinedPrompt).toContain(
      "Plan releases with concrete milestones."
    );
    expect(agent?.combinedPrompt).not.toContain("owner: hidden");
    expect(agent?.combinedPrompt).not.toContain("metadata: hidden");
  });

  it("treats legacy orchestrator metadata as chat while preserving configured delegates", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "gemma-agent-store-"));
    createdRoots.push(root);
    const workspace = createWorkspace(root);
    const defaultRoot = path.join(workspace.agentsRoot, "default");
    const agentRoot = path.join(workspace.agentsRoot, "release-planner");

    await Promise.all([
      mkdir(defaultRoot, { recursive: true }),
      mkdir(agentRoot, { recursive: true }),
      mkdir(path.join(workspace.agentsRoot, "release-tasker"), {
        recursive: true,
      }),
      mkdir(path.join(workspace.agentsRoot, "qa-tasker"), { recursive: true }),
      mkdir(workspace.memoryRoot, { recursive: true }),
      mkdir(workspace.skillsRoot, { recursive: true }),
      mkdir(workspace.copilotSkillsRoot, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(path.join(defaultRoot, "SOUL.md"), "Default soul.\n", "utf8"),
      writeFile(
        path.join(agentRoot, "AGENT.md"),
        [
          "---",
          "title: Release Orchestrator",
          "agent_type: orchestrator",
          'delegates_to: ["agent-release-tasker", "agent-qa-tasker"]',
          "---",
          "Coordinate multi-step release work.",
        ].join("\n"),
        "utf8"
      ),
      writeFile(
        path.join(workspace.agentsRoot, "release-tasker", "AGENT.md"),
        "Release tasker.\n",
        "utf8"
      ),
      writeFile(
        path.join(workspace.agentsRoot, "qa-tasker", "AGENT.md"),
        "QA tasker.\n",
        "utf8"
      ),
    ]);

    const agent = await getAgentById(workspace, "release-planner");
    expect(agent?.kind).toBe("chat");
    expect(agent?.delegatedAgentIds).toEqual(["release-tasker", "qa-tasker"]);
    expect(agent?.combinedPrompt).not.toContain("## Execution mode");
    expect(agent?.combinedPrompt).not.toContain("delegate-task");
  });

  it("does not default orchestrator delegation targets to every other agent", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "gemma-agent-store-"));
    createdRoots.push(root);
    const workspace = createWorkspace(root);
    const defaultRoot = path.join(workspace.agentsRoot, "default");
    const orchestratorRoot = path.join(workspace.agentsRoot, "release-planner");
    const qaRoot = path.join(workspace.agentsRoot, "qa-tasker");
    const writerRoot = path.join(workspace.agentsRoot, "writer");

    await Promise.all([
      mkdir(defaultRoot, { recursive: true }),
      mkdir(orchestratorRoot, { recursive: true }),
      mkdir(qaRoot, { recursive: true }),
      mkdir(writerRoot, { recursive: true }),
      mkdir(workspace.memoryRoot, { recursive: true }),
      mkdir(workspace.skillsRoot, { recursive: true }),
      mkdir(workspace.copilotSkillsRoot, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(path.join(defaultRoot, "SOUL.md"), "Default soul.\n", "utf8"),
      writeFile(
        path.join(orchestratorRoot, "AGENT.md"),
        [
          "---",
          "title: Release Orchestrator",
          "kind: orchestrator",
          "---",
          "Coordinate multi-step release work.",
        ].join("\n"),
        "utf8"
      ),
      writeFile(path.join(qaRoot, "AGENT.md"), "QA tasker.\n", "utf8"),
      writeFile(path.join(writerRoot, "AGENT.md"), "Writer.\n", "utf8"),
    ]);

    const agent = await getAgentById(workspace, "release-planner");

    expect(agent?.kind).toBe("chat");
    expect(agent?.delegatedAgentIds).toEqual([]);
    expect(agent?.combinedPrompt).not.toContain("## Execution mode");
  });

  it("defaults planner delegation targets to the other agents in the workspace", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "gemma-agent-store-"));
    createdRoots.push(root);
    const workspace = createWorkspace(root);
    const defaultRoot = path.join(workspace.agentsRoot, "default");
    const plannerRoot = path.join(workspace.agentsRoot, "fiction-generator");
    const writerRoot = path.join(workspace.agentsRoot, "scene-writer");
    const editorRoot = path.join(workspace.agentsRoot, "story-editor");

    await Promise.all([
      mkdir(defaultRoot, { recursive: true }),
      mkdir(plannerRoot, { recursive: true }),
      mkdir(writerRoot, { recursive: true }),
      mkdir(editorRoot, { recursive: true }),
      mkdir(workspace.memoryRoot, { recursive: true }),
      mkdir(workspace.skillsRoot, { recursive: true }),
      mkdir(workspace.copilotSkillsRoot, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(path.join(defaultRoot, "SOUL.md"), "Default soul.\n", "utf8"),
      writeFile(
        path.join(plannerRoot, "AGENT.md"),
        [
          "---",
          "title: Fiction Generator",
          "kind: planner",
          "---",
          "Plan multi-stage story work.",
        ].join("\n"),
        "utf8"
      ),
      writeFile(path.join(writerRoot, "AGENT.md"), "Scene writer.\n", "utf8"),
      writeFile(path.join(editorRoot, "AGENT.md"), "Story editor.\n", "utf8"),
    ]);

    const agent = await getAgentById(workspace, "fiction-generator");

    expect(agent?.kind).toBe("planner");
    expect(agent?.delegatedAgentIds).toEqual(["scene-writer", "story-editor"]);
    expect(agent?.combinedPrompt).not.toContain("delegate-task");
  });

  it("defaults chat delegation targets to the other agents in the workspace", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "gemma-agent-store-"));
    createdRoots.push(root);
    const workspace = createWorkspace(root);
    const defaultRoot = path.join(workspace.agentsRoot, "default");
    const chatRoot = path.join(workspace.agentsRoot, "fiction-generator");
    const writerRoot = path.join(workspace.agentsRoot, "scene-writer");
    const editorRoot = path.join(workspace.agentsRoot, "story-editor");

    await Promise.all([
      mkdir(defaultRoot, { recursive: true }),
      mkdir(chatRoot, { recursive: true }),
      mkdir(writerRoot, { recursive: true }),
      mkdir(editorRoot, { recursive: true }),
      mkdir(workspace.memoryRoot, { recursive: true }),
      mkdir(workspace.skillsRoot, { recursive: true }),
      mkdir(workspace.copilotSkillsRoot, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(path.join(defaultRoot, "SOUL.md"), "Default soul.\n", "utf8"),
      writeFile(
        path.join(chatRoot, "AGENT.md"),
        [
          "---",
          "title: Fiction Generator",
          "---",
          "Write and coordinate fiction work.",
        ].join("\n"),
        "utf8"
      ),
      writeFile(path.join(writerRoot, "AGENT.md"), "Scene writer.\n", "utf8"),
      writeFile(path.join(editorRoot, "AGENT.md"), "Story editor.\n", "utf8"),
    ]);

    const agent = await getAgentById(workspace, "fiction-generator");

    expect(agent?.kind).toBe("chat");
    expect(agent?.delegatedAgentIds).toEqual(["scene-writer", "story-editor"]);
    expect(agent?.combinedPrompt).not.toContain("## Execution mode");
  });
});

describe("listSkillsForAgent", () => {
  it("detects a single executable script in the standard scripts directory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "gemma-agent-store-"));
    createdRoots.push(root);
    const workspace = createWorkspace(root);
    await createAgentFixture(workspace, {});

    const skillRoot = path.join(
      workspace.agentsRoot,
      "release-planner",
      "skills",
      "release-notes"
    );
    await mkdir(path.join(skillRoot, "scripts"), { recursive: true });
    await Promise.all([
      writeFile(
        path.join(skillRoot, "SKILL.md"),
        "---\nname: release-notes\ndescription: Draft release notes.\n---\nUse this skill for release notes.\n",
        "utf8"
      ),
      writeFile(
        path.join(skillRoot, "scripts", "generate.sh"),
        '#!/bin/bash\necho "notes"',
        { mode: 0o755 }
      ),
    ]);

    const skills = await listSkillsForAgent(workspace, "release-planner");
    expect(skills).toEqual([
      expect.objectContaining({
        name: "release-notes",
        hasScript: true,
        scriptPath: path.join(skillRoot, "scripts", "generate.sh"),
      }),
    ]);
  });

  it("treats multiple scripts in the scripts directory as non-executable", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "gemma-agent-store-"));
    createdRoots.push(root);
    const workspace = createWorkspace(root);
    await createAgentFixture(workspace, {});

    const skillRoot = path.join(
      workspace.agentsRoot,
      "release-planner",
      "skills",
      "release-notes"
    );
    await mkdir(path.join(skillRoot, "scripts"), { recursive: true });
    await Promise.all([
      writeFile(
        path.join(skillRoot, "SKILL.md"),
        "---\nname: release-notes\ndescription: Draft release notes.\n---\nUse this skill for release notes.\n",
        "utf8"
      ),
      writeFile(
        path.join(skillRoot, "scripts", "generate.sh"),
        '#!/bin/bash\necho "notes"',
        { mode: 0o755 }
      ),
      writeFile(
        path.join(skillRoot, "scripts", "cleanup.py"),
        'print("cleanup")',
        "utf8"
      ),
    ]);

    const skills = await listSkillsForAgent(workspace, "release-planner");
    expect(skills).toEqual([
      expect.objectContaining({
        name: "release-notes",
        hasScript: false,
      }),
    ]);
  });
});

describe("loadEnabledSkillDocumentsForAgent", () => {
  it("strips markdown frontmatter from skill content", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "gemma-agent-store-"));
    createdRoots.push(root);
    const workspace = createWorkspace(root);
    await createAgentFixture(workspace, {});

    const skillRoot = path.join(
      workspace.agentsRoot,
      "release-planner",
      "skills",
      "release-notes"
    );
    await mkdir(skillRoot, { recursive: true });
    await writeFile(
      path.join(skillRoot, "SKILL.md"),
      [
        "---",
        "name: release-notes",
        "description: Hidden metadata should stay out of the prompt.",
        "---",
        "Draft release notes from the latest shipped changes.",
      ].join("\n"),
      "utf8"
    );

    const skills = await loadEnabledSkillDocumentsForAgent(
      workspace,
      "release-planner"
    );

    expect(skills).toEqual([
      expect.objectContaining({
        name: "release-notes",
        content: "Draft release notes from the latest shipped changes.",
      }),
    ]);
    expect(skills[0]?.content).not.toContain("Hidden metadata");
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
