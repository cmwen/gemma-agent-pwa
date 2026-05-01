import { describe, expect, it } from "vitest";
import {
  applyPresetRuntimeConfigDefaults,
  DEFAULT_CONTEXT_WINDOW_SIZE,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  GEMMA_BALANCED_PRESET_ID,
  GEMMA_DEEP_PRESET_ID,
  mergeRuntimeConfig,
  normalizeRuntimeConfig,
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
});
