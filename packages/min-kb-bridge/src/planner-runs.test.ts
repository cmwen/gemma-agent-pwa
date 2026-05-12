import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PlannerRun } from "@gemma-agent-pwa/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  deletePlannerRun,
  getPlannerRun,
  listPlannerRuns,
  upsertPlannerRun,
} from "./planner-runs.js";
import type { MinKbWorkspace } from "./workspace.js";

const createdRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    createdRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe("planner run persistence", () => {
  it("stores, lists, and updates planner runs by planner agent", async () => {
    const workspace = await createWorkspace();

    await upsertPlannerRun(workspace, buildPlannerRun());
    await upsertPlannerRun(workspace, buildPlannerRun({ runId: "run-2" }));

    expect(await listPlannerRuns(workspace, "release-planner")).toHaveLength(2);

    await upsertPlannerRun(
      workspace,
      buildPlannerRun({
        runId: "run-1",
        status: "error",
        lastError: "Task failed.",
        tasks: [
          {
            id: "task-1",
            title: "Fetch release notes",
            taskerAgentId: "release-tasker",
            prompt: "Collect release notes for 1.2.3.",
            status: "success",
            attemptCount: 1,
            resultSessionId: "planner-run-1-task-1",
            resultSummary: "Release notes collected.",
          },
        ],
      })
    );

    expect(
      await getPlannerRun(workspace, "release-planner", "run-1")
    ).toMatchObject({
      status: "error",
      lastError: "Task failed.",
      tasks: [{ status: "success" }],
    });
  });

  it("can list planner runs across planners and delete one run", async () => {
    const workspace = await createWorkspace();

    await upsertPlannerRun(workspace, buildPlannerRun());
    await upsertPlannerRun(
      workspace,
      buildPlannerRun({
        plannerAgentId: "ops-planner",
        runId: "run-2",
      })
    );

    expect(await listPlannerRuns(workspace)).toHaveLength(2);
    await deletePlannerRun(workspace, "release-planner", "run-1");
    expect(await listPlannerRuns(workspace, "release-planner")).toHaveLength(0);
    expect(await listPlannerRuns(workspace)).toHaveLength(1);
  });
});

async function createWorkspace(): Promise<MinKbWorkspace> {
  const root = await mkdtemp(path.join(tmpdir(), "gemma-agent-store-"));
  createdRoots.push(root);
  return {
    storeRoot: root,
    agentsRoot: path.join(root, "agents"),
    memoryRoot: path.join(root, "memory"),
    skillsRoot: path.join(root, "skills"),
    copilotConfigDir: path.join(root, ".copilot"),
    copilotSkillsRoot: path.join(root, ".copilot", "skills"),
  };
}

function buildPlannerRun(overrides: Partial<PlannerRun> = {}): PlannerRun {
  return {
    runId: "run-1",
    plannerAgentId: "release-planner",
    title: "Release rollout plan",
    objective: "Prepare and validate release rollout tasks.",
    status: "pending",
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
    tasks: [
      {
        id: "task-1",
        title: "Fetch release notes",
        taskerAgentId: "release-tasker",
        prompt: "Collect release notes for 1.2.3.",
        status: "pending",
        attemptCount: 0,
      },
    ],
    ...overrides,
  };
}
