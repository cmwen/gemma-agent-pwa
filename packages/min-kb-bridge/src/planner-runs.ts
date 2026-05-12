import { promises as fs } from "node:fs";
import path from "node:path";
import type { PlannerRun } from "@gemma-agent-pwa/contracts";
import { plannerRunSchema } from "@gemma-agent-pwa/contracts";
import { normalizeAgentId, pathExists } from "./utils.js";
import type { MinKbWorkspace } from "./workspace.js";

const plannerRunListSchema = plannerRunSchema.array();

export async function listPlannerRuns(
  workspace: MinKbWorkspace,
  plannerAgentId?: string
): Promise<PlannerRun[]> {
  if (plannerAgentId) {
    return readPlannerRunsForAgent(workspace, plannerAgentId);
  }

  const root = plannerRunsRoot(workspace);
  if (!(await pathExists(root))) {
    return [];
  }

  const entries = await fs.readdir(root, { withFileTypes: true });
  const runs = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) =>
        readPlannerRunsForAgent(
          workspace,
          entry.name.slice(0, entry.name.length - ".json".length)
        )
      )
  );
  return runs
    .flat()
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function getPlannerRun(
  workspace: MinKbWorkspace,
  plannerAgentId: string,
  runId: string
): Promise<PlannerRun | undefined> {
  return (await readPlannerRunsForAgent(workspace, plannerAgentId)).find(
    (run) => run.runId === runId
  );
}

export async function upsertPlannerRun(
  workspace: MinKbWorkspace,
  run: PlannerRun
): Promise<PlannerRun> {
  const normalizedRun = plannerRunSchema.parse({
    ...run,
    plannerAgentId: normalizeAgentId(run.plannerAgentId),
    tasks: run.tasks.map((task) => ({
      ...task,
      taskerAgentId: normalizeAgentId(task.taskerAgentId),
    })),
  });
  const runs = await readPlannerRunsForAgent(
    workspace,
    normalizedRun.plannerAgentId
  );
  const nextRuns = runs.some((entry) => entry.runId === normalizedRun.runId)
    ? runs.map((entry) =>
        entry.runId === normalizedRun.runId ? normalizedRun : entry
      )
    : [normalizedRun, ...runs];

  await writePlannerRunsForAgent(
    workspace,
    normalizedRun.plannerAgentId,
    nextRuns
  );
  return normalizedRun;
}

export async function deletePlannerRun(
  workspace: MinKbWorkspace,
  plannerAgentId: string,
  runId: string
): Promise<void> {
  const normalizedPlannerAgentId = normalizeAgentId(plannerAgentId);
  const runs = await readPlannerRunsForAgent(
    workspace,
    normalizedPlannerAgentId
  );
  const nextRuns = runs.filter((run) => run.runId !== runId);
  if (nextRuns.length === runs.length) {
    throw new Error(
      `Planner run not found for planner ${normalizedPlannerAgentId}: ${runId}`
    );
  }
  await writePlannerRunsForAgent(workspace, normalizedPlannerAgentId, nextRuns);
}

async function readPlannerRunsForAgent(
  workspace: MinKbWorkspace,
  plannerAgentId: string
): Promise<PlannerRun[]> {
  const filePath = plannerRunsPath(workspace, plannerAgentId);
  if (!(await pathExists(filePath))) {
    return [];
  }

  return plannerRunListSchema.parse(
    JSON.parse(await fs.readFile(filePath, "utf8"))
  );
}

async function writePlannerRunsForAgent(
  workspace: MinKbWorkspace,
  plannerAgentId: string,
  runs: PlannerRun[]
): Promise<void> {
  const filePath = plannerRunsPath(workspace, plannerAgentId);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    `${JSON.stringify(
      runs
        .map((run) =>
          plannerRunSchema.parse({
            ...run,
            plannerAgentId: normalizeAgentId(plannerAgentId),
            tasks: run.tasks.map((task) => ({
              ...task,
              taskerAgentId: normalizeAgentId(task.taskerAgentId),
            })),
          })
        )
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
      null,
      2
    )}\n`,
    "utf8"
  );
}

function plannerRunsRoot(workspace: MinKbWorkspace): string {
  return path.join(workspace.memoryRoot, "gemma-agent-pwa", "planner-runs");
}

function plannerRunsPath(
  workspace: MinKbWorkspace,
  plannerAgentId: string
): string {
  return path.join(
    plannerRunsRoot(workspace),
    `${normalizeAgentId(plannerAgentId)}.json`
  );
}
