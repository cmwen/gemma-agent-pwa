import { describe, expect, it } from "vitest";
import {
  applyPresetRuntimeConfigDefaults,
  DEFAULT_CONTEXT_WINDOW_SIZE,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  GEMMA_BALANCED_PRESET_ID,
  GEMMA_DEEP_PRESET_ID,
  mergeRuntimeConfig,
  normalizeProviderId,
  normalizeRuntimeConfig,
  requireConfiguredProvider,
  scheduledTaskCreateSchema,
  scheduledTaskSchema,
} from "./index";

describe("runtime config helpers", () => {
  it("normalizes merged configs before preset defaults are applied", () => {
    expect(
      normalizeRuntimeConfig([
        {
          model: "google/gemma-3-12b",
        },
      ])
    ).toEqual({
      provider: DEFAULT_PROVIDER,
      model: "google/gemma-3-12b",
      presetId: GEMMA_BALANCED_PRESET_ID,
      disabledSkills: [],
    });
  });

  it("fills missing runtime fields from the selected preset", () => {
    expect(
      applyPresetRuntimeConfigDefaults({
        provider: DEFAULT_PROVIDER,
        model: DEFAULT_MODEL,
        presetId: GEMMA_DEEP_PRESET_ID,
        disabledSkills: [],
      })
    ).toMatchObject({
      provider: DEFAULT_PROVIDER,
      model: DEFAULT_MODEL,
      presetId: GEMMA_DEEP_PRESET_ID,
      lmStudioEnableThinking: true,
      maxCompletionTokens: 8192,
      contextWindowSize: DEFAULT_CONTEXT_WINDOW_SIZE,
      temperature: 0.15,
      topP: 0.95,
      disabledSkills: [],
    });
  });

  it("preserves explicit overrides when a later config changes the preset", () => {
    expect(
      mergeRuntimeConfig(
        {
          model: "google/gemma-3-12b",
          presetId: GEMMA_BALANCED_PRESET_ID,
          maxCompletionTokens: 1024,
        },
        {
          presetId: GEMMA_DEEP_PRESET_ID,
          topP: 0.72,
        }
      )
    ).toMatchObject({
      provider: DEFAULT_PROVIDER,
      model: "google/gemma-3-12b",
      presetId: GEMMA_DEEP_PRESET_ID,
      lmStudioEnableThinking: true,
      maxCompletionTokens: 1024,
      contextWindowSize: DEFAULT_CONTEXT_WINDOW_SIZE,
      temperature: 0.15,
      topP: 0.72,
      disabledSkills: [],
    });
  });

  it("keeps the configured LM Studio provider while still applying preset defaults", () => {
    expect(
      applyPresetRuntimeConfigDefaults({
        provider: DEFAULT_PROVIDER,
        model: DEFAULT_MODEL,
        presetId: GEMMA_BALANCED_PRESET_ID,
        disabledSkills: [],
      })
    ).toMatchObject({
      provider: DEFAULT_PROVIDER,
      model: DEFAULT_MODEL,
      presetId: GEMMA_BALANCED_PRESET_ID,
      lmStudioEnableThinking: true,
      maxCompletionTokens: 4096,
      contextWindowSize: DEFAULT_CONTEXT_WINDOW_SIZE,
      temperature: 0.2,
      topP: 0.95,
      disabledSkills: [],
    });
  });

  it("normalizes LM Studio aliases for the active provider", () => {
    expect(normalizeProviderId(" LM Studio ")).toBe(DEFAULT_PROVIDER);
    expect(requireConfiguredProvider(" LM Studio ")).toBe(DEFAULT_PROVIDER);
  });

  it("rejects unsupported providers until another adapter is configured", () => {
    expect(() => requireConfiguredProvider("future-provider")).toThrow(
      'Unsupported LLM provider "future-provider". LM Studio is the only configured provider.'
    );
  });
});

describe("scheduled task schemas", () => {
  it("accepts hourly, daily, and weekly schedules with matching fields", () => {
    expect(
      scheduledTaskCreateSchema.parse({
        agentId: "release-planner",
        title: "Hourly digest",
        prompt: "Summarize the latest activity.",
        recurrence: "hourly",
        minuteOfHour: 15,
        timezone: "Australia/Sydney",
        enabled: true,
        notifyOnCompletion: true,
        sessionMode: "dedicated",
      })
    ).toMatchObject({
      recurrence: "hourly",
      minuteOfHour: 15,
    });

    expect(
      scheduledTaskCreateSchema.parse({
        agentId: "release-planner",
        title: "Daily digest",
        prompt: "Summarize the latest activity.",
        recurrence: "daily",
        minuteOfHour: 30,
        hourOfDay: 9,
        timezone: "Australia/Sydney",
        enabled: true,
        notifyOnCompletion: true,
        sessionMode: "fresh",
      })
    ).toMatchObject({
      recurrence: "daily",
      hourOfDay: 9,
    });

    expect(
      scheduledTaskSchema.parse({
        id: "task-1",
        agentId: "release-planner",
        title: "Weekly digest",
        prompt: "Summarize the latest activity.",
        recurrence: "weekly",
        minuteOfHour: 45,
        hourOfDay: 8,
        dayOfWeek: 1,
        timezone: "Australia/Sydney",
        enabled: true,
        notifyOnCompletion: true,
        sessionMode: "dedicated",
        createdAt: "2026-05-01T00:00:00.000Z",
        updatedAt: "2026-05-01T00:00:00.000Z",
        nextRunAt: "2026-05-05T22:45:00.000Z",
        recentRuns: [],
      })
    ).toMatchObject({
      recurrence: "weekly",
      dayOfWeek: 1,
    });
  });

  it("rejects recurrence combinations that omit required fields", () => {
    expect(() =>
      scheduledTaskCreateSchema.parse({
        agentId: "release-planner",
        title: "Broken daily task",
        prompt: "Summarize the latest activity.",
        recurrence: "daily",
        minuteOfHour: 15,
        timezone: "Australia/Sydney",
        enabled: true,
        notifyOnCompletion: true,
        sessionMode: "dedicated",
      })
    ).toThrow(/hour of day/i);

    expect(() =>
      scheduledTaskCreateSchema.parse({
        agentId: "release-planner",
        title: "Broken weekly task",
        prompt: "Summarize the latest activity.",
        recurrence: "weekly",
        minuteOfHour: 15,
        hourOfDay: 9,
        timezone: "Australia/Sydney",
        enabled: true,
        notifyOnCompletion: true,
        sessionMode: "dedicated",
      })
    ).toThrow(/day of week/i);
  });
});
