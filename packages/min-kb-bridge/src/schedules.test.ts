import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ScheduledTask } from "@gemma-agent-pwa/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  deleteScheduledTask,
  getScheduledTask,
  listScheduledTasks,
  upsertScheduledTask,
} from "./schedules.js";
import type { MinKbWorkspace } from "./workspace.js";

const createdRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    createdRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe("scheduled task persistence", () => {
  it("stores, lists, and updates scheduled tasks by agent", async () => {
    const workspace = await createWorkspace();

    await upsertScheduledTask(workspace, buildTask());
    await upsertScheduledTask(workspace, buildTask({ id: "task-2" }));

    const tasks = await listScheduledTasks(workspace, "release-planner");
    expect(tasks).toHaveLength(2);

    await upsertScheduledTask(
      workspace,
      buildTask({
        id: "task-1",
        enabled: false,
        recentRuns: [
          {
            runId: "run-1",
            status: "success",
            trigger: "manual",
            scheduledFor: "2026-05-03T00:15:00.000Z",
            startedAt: "2026-05-03T00:15:00.000Z",
            completedAt: "2026-05-03T00:15:10.000Z",
            sessionId: "schedule-task-1",
            assistantSummary: "Ready.",
          },
        ],
      })
    );

    expect(
      await getScheduledTask(workspace, "release-planner", "task-1")
    ).toMatchObject({
      enabled: false,
      recentRuns: [
        {
          runId: "run-1",
          status: "success",
        },
      ],
    });
  });

  it("can list tasks across agents and delete a single task", async () => {
    const workspace = await createWorkspace();

    await upsertScheduledTask(workspace, buildTask());
    await upsertScheduledTask(
      workspace,
      buildTask({
        agentId: "ops-watcher",
        id: "task-2",
      })
    );

    expect(await listScheduledTasks(workspace)).toHaveLength(2);

    await deleteScheduledTask(workspace, "release-planner", "task-1");

    expect(await listScheduledTasks(workspace, "release-planner")).toHaveLength(
      0
    );
    expect(await listScheduledTasks(workspace)).toHaveLength(1);
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

function buildTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "task-1",
    agentId: "release-planner",
    title: "Hourly digest",
    prompt: "Summarize the latest activity.",
    recurrence: "hourly",
    minuteOfHour: 15,
    timezone: "Australia/Sydney",
    enabled: true,
    notifyOnCompletion: true,
    sessionMode: "dedicated",
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
    nextRunAt: "2026-05-03T00:15:00.000Z",
    recentRuns: [],
    ...overrides,
  };
}
