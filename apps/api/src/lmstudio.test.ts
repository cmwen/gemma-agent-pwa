import { afterEach, describe, expect, it, vi } from "vitest";
import { __testing, getLmStudioModelCatalog } from "./lmstudio.js";

const originalLmStudioModel = process.env.LM_STUDIO_MODEL;

afterEach(() => {
  vi.restoreAllMocks();
  if (originalLmStudioModel === undefined) {
    delete process.env.LM_STUDIO_MODEL;
  } else {
    process.env.LM_STUDIO_MODEL = originalLmStudioModel;
  }
});

describe("lmstudio parsing", () => {
  it("separates leading thinking blocks from visible content", () => {
    expect(
      __testing.extractPayloadSections(
        "<think>Review the prompt carefully.</think>\n\nFinal answer."
      )
    ).toEqual({
      assistantText: "Final answer.",
      thinkingText: "Review the prompt carefully.",
    });
  });

  it("combines repeated streaming snapshots without duplication", () => {
    expect(
      __testing.combineTextCandidates([
        "Plan the migration.",
        "Plan the migration.\nThen summarize the risk.",
        "Plan the migration.",
      ])
    ).toBe("Plan the migration.\nThen summarize the risk.");
  });
});

describe("LM Studio model catalog", () => {
  it("marks configured fallback models as unavailable when discovery fails", async () => {
    process.env.LM_STUDIO_MODEL = "google/gemma-3-4b";
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("connect ECONNREFUSED")
    );

    await expect(getLmStudioModelCatalog()).resolves.toEqual({
      models: [
        {
          id: "google/gemma-3-4b",
          displayName: "google/gemma-3-4b",
          provider: "LM Studio",
          isGemma: true,
        },
      ],
      reachable: false,
    });
  });
});
