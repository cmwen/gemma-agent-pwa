import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getSession, saveChatTurn } from "./sessions.js";
import type { MinKbWorkspace } from "./workspace.js";

const createdRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    createdRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe("saveChatTurn", () => {
  it("persists assistant thinking metadata separately from the visible body", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "gemma-agent-store-"));
    createdRoots.push(root);
    const workspace = createWorkspace(root);

    const initialThread = await saveChatTurn(workspace, {
      agentId: "release-planner",
      sender: "user",
      title: "Release planning",
      bodyMarkdown: "Outline the release checklist.",
    });

    const thread = await saveChatTurn(workspace, {
      agentId: "release-planner",
      sender: "assistant",
      sessionId: initialThread.sessionId,
      bodyMarkdown: "1. Run regression tests.\n2. Prepare release notes.",
      thinkingMarkdown:
        "Compare the regression checklist with recent incidents.",
    });

    const assistantTurn = thread.turns.find(
      (turn) => turn.sender === "assistant"
    );
    expect(assistantTurn?.thinkingMarkdown).toBe(
      "Compare the regression checklist with recent incidents."
    );

    const reloaded = await getSession(
      workspace,
      "release-planner",
      initialThread.sessionId
    );
    const reloadedAssistantTurn = reloaded.turns.find(
      (turn) => turn.sender === "assistant"
    );
    expect(reloadedAssistantTurn?.thinkingMarkdown).toBe(
      "Compare the regression checklist with recent incidents."
    );

    const metadataPath = path.join(
      root,
      reloadedAssistantTurn?.relativePath
        ? `${reloadedAssistantTurn.relativePath}.json`
        : ""
    );
    const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as {
      thinkingMarkdown?: string;
    };
    expect(metadata.thinkingMarkdown).toBe(
      "Compare the regression checklist with recent incidents."
    );
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
