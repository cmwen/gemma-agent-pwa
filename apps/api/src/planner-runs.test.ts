import { describe, expect, it } from "vitest";
import { __testing } from "./planner-runs.js";

describe("planner run helpers", () => {
  it("creates planner runs with pending task state", () => {
    const run = __testing.createPlannerRun({
      plannerAgentId: "release-planner",
      objective: "Prepare release.",
      tasks: [
        {
          title: "Validate changelog",
          taskerAgentId: "release-tasker",
          prompt: "Validate changelog entries.",
        },
      ],
    });

    expect(run.status).toBe("pending");
    expect(run.tasks).toEqual([
      expect.objectContaining({
        id: "task-1",
        status: "pending",
        attemptCount: 0,
        taskerAgentId: "release-tasker",
      }),
    ]);
  });

  it("builds deterministic tasker session ids for resume", () => {
    expect(__testing.buildTaskerSessionId("Run_42", "Check docs + tests")).toBe(
      "planner-run-42-task-check-docs-tests"
    );
  });
});
