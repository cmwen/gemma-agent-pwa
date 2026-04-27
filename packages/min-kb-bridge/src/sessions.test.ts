import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  deleteSession,
  getSession,
  listSessions,
  restoreSession,
  saveChatTurn,
  softDeleteSession,
} from "./sessions.js";
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

describe("listSessions", () => {
  it("moves soft-deleted sessions into the deleted listing until restored", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "gemma-agent-store-"));
    createdRoots.push(root);
    const workspace = createWorkspace(root);

    const thread = await saveChatTurn(workspace, {
      agentId: "release-planner",
      sender: "user",
      title: "Delete me later",
      bodyMarkdown: "Archive this session.",
    });

    const deleted = await softDeleteSession(
      workspace,
      "release-planner",
      thread.sessionId
    );
    expect(deleted.deletedAt).toBeTruthy();

    const activeSessions = await listSessions(workspace, "release-planner");
    expect(activeSessions).toHaveLength(0);

    const deletedSessions = await listSessions(workspace, "release-planner", {
      state: "deleted",
    });
    expect(deletedSessions).toHaveLength(1);
    expect(deletedSessions[0]).toMatchObject({
      sessionId: thread.sessionId,
      deletedAt: deleted.deletedAt,
    });

    const deletedThread = await getSession(
      workspace,
      "release-planner",
      thread.sessionId
    );
    expect(deletedThread.deletedAt).toBe(deleted.deletedAt);

    await expect(
      saveChatTurn(workspace, {
        agentId: "release-planner",
        sender: "assistant",
        sessionId: thread.sessionId,
        bodyMarkdown: "This should not be appended.",
      })
    ).rejects.toThrow(/deleted session/i);

    const restored = await restoreSession(
      workspace,
      "release-planner",
      thread.sessionId
    );
    expect(restored.deletedAt).toBeUndefined();
    expect(await listSessions(workspace, "release-planner")).toHaveLength(1);
    expect(
      await listSessions(workspace, "release-planner", {
        state: "deleted",
      })
    ).toHaveLength(0);
  });

  it("permanently deletes sessions from disk", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "gemma-agent-store-"));
    createdRoots.push(root);
    const workspace = createWorkspace(root);

    const thread = await saveChatTurn(workspace, {
      agentId: "release-planner",
      sender: "user",
      title: "Delete forever",
      bodyMarkdown: "Purge this session.",
    });

    await deleteSession(workspace, "release-planner", thread.sessionId);

    expect(await listSessions(workspace, "release-planner")).toHaveLength(0);
    await expect(
      getSession(workspace, "release-planner", thread.sessionId)
    ).rejects.toThrow(/session not found/i);
  });

  it("normalizes legacy LM Studio runtime config aliases", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "gemma-agent-store-"));
    createdRoots.push(root);
    const workspace = createWorkspace(root);

    const thread = await saveChatTurn(workspace, {
      agentId: "release-planner",
      sender: "user",
      title: "Legacy runtime",
      bodyMarkdown: "Load the session.",
      runtimeConfig: {
        provider: "lmstudio",
        model: "google/gemma-3-4b",
        presetId: "gemma4-balanced",
        lmStudioEnableThinking: true,
        maxCompletionTokens: 4096,
        contextWindowSize: 32768,
        temperature: 0.2,
        topP: 0.95,
        disabledSkills: [],
      },
    });

    await writeFile(
      path.join(root, path.dirname(thread.manifestPath), "RUNTIME.json"),
      `${JSON.stringify(
        {
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
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const [summary] = await listSessions(workspace, "release-planner");
    expect(summary?.runtimeConfig).toEqual({
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

    const thread = await saveChatTurn(workspace, {
      agentId: "release-planner",
      sender: "user",
      title: "Copilot history",
      bodyMarkdown: "Load the session.",
      runtimeConfig: {
        provider: "lmstudio",
        model: "google/gemma-3-4b",
        presetId: "gemma4-balanced",
        lmStudioEnableThinking: true,
        maxCompletionTokens: 4096,
        contextWindowSize: 32768,
        temperature: 0.2,
        topP: 0.95,
        disabledSkills: [],
      },
    });

    await writeFile(
      path.join(root, path.dirname(thread.manifestPath), "RUNTIME.json"),
      `${JSON.stringify(
        {
          provider: "copilot",
          model: "gpt-5",
          disabledSkills: [],
          reasoningEffort: "high",
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const [summary] = await listSessions(workspace, "release-planner");
    expect(summary?.runtimeConfig).toBeUndefined();
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
