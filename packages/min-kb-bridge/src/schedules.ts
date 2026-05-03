import { promises as fs } from "node:fs";
import path from "node:path";
import type { ScheduledTask } from "@gemma-agent-pwa/contracts";
import { scheduledTaskSchema } from "@gemma-agent-pwa/contracts";
import { normalizeAgentId, pathExists } from "./utils.js";
import type { MinKbWorkspace } from "./workspace.js";

const scheduledTaskListSchema = scheduledTaskSchema.array();

export async function listScheduledTasks(
  workspace: MinKbWorkspace,
  agentId?: string
): Promise<ScheduledTask[]> {
  if (agentId) {
    return readAgentScheduledTasks(workspace, agentId);
  }

  const root = scheduledTasksRoot(workspace);
  if (!(await pathExists(root))) {
    return [];
  }

  const entries = await fs.readdir(root, { withFileTypes: true });
  const tasks = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) =>
        readAgentScheduledTasks(
          workspace,
          entry.name.slice(0, entry.name.length - ".json".length)
        )
      )
  );
  return tasks
    .flat()
    .sort((left, right) => left.nextRunAt.localeCompare(right.nextRunAt));
}

export async function getScheduledTask(
  workspace: MinKbWorkspace,
  agentId: string,
  taskId: string
): Promise<ScheduledTask | undefined> {
  return (await readAgentScheduledTasks(workspace, agentId)).find(
    (task) => task.id === taskId
  );
}

export async function upsertScheduledTask(
  workspace: MinKbWorkspace,
  task: ScheduledTask
): Promise<ScheduledTask> {
  const normalizedTask = scheduledTaskSchema.parse({
    ...task,
    agentId: normalizeAgentId(task.agentId),
  });
  const tasks = await readAgentScheduledTasks(
    workspace,
    normalizedTask.agentId
  );
  const nextTasks = tasks.some((entry) => entry.id === normalizedTask.id)
    ? tasks.map((entry) =>
        entry.id === normalizedTask.id ? normalizedTask : entry
      )
    : [...tasks, normalizedTask];
  await writeAgentScheduledTasks(workspace, normalizedTask.agentId, nextTasks);
  return normalizedTask;
}

export async function deleteScheduledTask(
  workspace: MinKbWorkspace,
  agentId: string,
  taskId: string
): Promise<void> {
  const normalizedAgentId = normalizeAgentId(agentId);
  const tasks = await readAgentScheduledTasks(workspace, normalizedAgentId);
  const nextTasks = tasks.filter((task) => task.id !== taskId);
  if (nextTasks.length === tasks.length) {
    throw new Error(
      `Scheduled task not found for agent ${normalizedAgentId}: ${taskId}`
    );
  }
  await writeAgentScheduledTasks(workspace, normalizedAgentId, nextTasks);
}

async function readAgentScheduledTasks(
  workspace: MinKbWorkspace,
  agentId: string
): Promise<ScheduledTask[]> {
  const filePath = scheduledTasksPath(workspace, agentId);
  if (!(await pathExists(filePath))) {
    return [];
  }
  return scheduledTaskListSchema.parse(
    JSON.parse(await fs.readFile(filePath, "utf8"))
  );
}

async function writeAgentScheduledTasks(
  workspace: MinKbWorkspace,
  agentId: string,
  tasks: ScheduledTask[]
): Promise<void> {
  const filePath = scheduledTasksPath(workspace, agentId);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    `${JSON.stringify(
      tasks
        .map((task) =>
          scheduledTaskSchema.parse({
            ...task,
            agentId: normalizeAgentId(agentId),
          })
        )
        .sort((left, right) => left.nextRunAt.localeCompare(right.nextRunAt)),
      null,
      2
    )}\n`,
    "utf8"
  );
}

function scheduledTasksRoot(workspace: MinKbWorkspace): string {
  return path.join(workspace.memoryRoot, "gemma-agent-pwa", "scheduled-tasks");
}

function scheduledTasksPath(
  workspace: MinKbWorkspace,
  agentId: string
): string {
  return path.join(
    scheduledTasksRoot(workspace),
    `${normalizeAgentId(agentId)}.json`
  );
}
