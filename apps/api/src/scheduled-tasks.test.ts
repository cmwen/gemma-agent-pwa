import { describe, expect, it, vi } from "vitest";
import { __testing } from "./scheduled-tasks.js";

describe("scheduled task timing helpers", () => {
  it("rounds candidate times up to the next minute", () => {
    expect(
      __testing
        .ceilToNextMinute(new Date("2026-05-03T10:15:12.000Z"))
        .toISOString()
    ).toBe("2026-05-03T10:16:00.000Z");
  });

  it("computes the next hourly, daily, and weekly run in the configured timezone", () => {
    expect(
      __testing.computeNextScheduledRun(
        {
          recurrence: "hourly",
          minuteOfHour: 30,
          timezone: "UTC",
        },
        new Date("2026-05-03T10:15:12.000Z")
      )
    ).toBe("2026-05-03T10:30:00.000Z");

    expect(
      __testing.computeNextScheduledRun(
        {
          recurrence: "daily",
          minuteOfHour: 15,
          hourOfDay: 9,
          timezone: "UTC",
        },
        new Date("2026-05-03T10:15:12.000Z")
      )
    ).toBe("2026-05-04T09:15:00.000Z");

    expect(
      __testing.computeNextScheduledRun(
        {
          recurrence: "weekly",
          minuteOfHour: 45,
          hourOfDay: 8,
          dayOfWeek: 1,
          timezone: "UTC",
        },
        new Date("2026-05-03T10:15:12.000Z")
      )
    ).toBe("2026-05-04T08:45:00.000Z");
  });
});

describe("scheduled task update helpers", () => {
  it("recomputes the next run when the cadence changes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-03T10:15:12.000Z"));

    const next = __testing.applyScheduledTaskUpdate(
      {
        id: "task-1",
        agentId: "release-planner",
        title: "Daily digest",
        prompt: "Summarize the latest activity.",
        recurrence: "daily",
        minuteOfHour: 15,
        hourOfDay: 9,
        timezone: "UTC",
        enabled: true,
        notifyOnCompletion: true,
        sessionMode: "dedicated",
        createdAt: "2026-05-01T00:00:00.000Z",
        updatedAt: "2026-05-01T00:00:00.000Z",
        nextRunAt: "2026-05-04T09:15:00.000Z",
        recentRuns: [],
      },
      {
        recurrence: "hourly",
        minuteOfHour: 45,
        hourOfDay: undefined,
      }
    );

    expect(next.nextRunAt).toBe("2026-05-03T10:45:00.000Z");
    vi.useRealTimers();
  });
});
