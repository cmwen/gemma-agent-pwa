import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __testing, getLmStudioModelCatalog } from "./lmstudio.js";

const originalLmStudioModel = process.env.LM_STUDIO_MODEL;
const originalLmStudioBaseUrl = process.env.LM_STUDIO_BASE_URL;

afterEach(() => {
  vi.restoreAllMocks();
  if (originalLmStudioModel === undefined) {
    delete process.env.LM_STUDIO_MODEL;
  } else {
    process.env.LM_STUDIO_MODEL = originalLmStudioModel;
  }
  if (originalLmStudioBaseUrl === undefined) {
    delete process.env.LM_STUDIO_BASE_URL;
  } else {
    process.env.LM_STUDIO_BASE_URL = originalLmStudioBaseUrl;
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

  it("falls back to localhost model discovery when loopback is unreachable", async () => {
    delete process.env.LM_STUDIO_BASE_URL;
    vi.spyOn(os, "hostname").mockReturnValue("minipc-wsl");
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((input) => {
        if (input === "http://127.0.0.1:1234/v1/models") {
          return Promise.reject(new Error("connect ECONNREFUSED"));
        }
        if (input === "http://localhost:1234/v1/models") {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                data: [{ id: "google/gemma-3-4b", owned_by: "LM Studio" }],
              })
            )
          );
        }
        return Promise.reject(new Error(`Unexpected URL: ${String(input)}`));
      });

    await expect(getLmStudioModelCatalog()).resolves.toEqual({
      models: [
        {
          id: "google/gemma-3-4b",
          displayName: "google/gemma-3-4b",
          provider: "LM Studio",
          isGemma: true,
        },
      ],
      reachable: true,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe("LM Studio URL helpers", () => {
  it("includes the current hostname in default candidate URLs", () => {
    delete process.env.LM_STUDIO_BASE_URL;
    vi.spyOn(os, "hostname").mockReturnValue("minipc-wsl");

    expect(__testing.getBaseUrlCandidates()).toContain(
      "http://minipc-wsl:1234/v1"
    );
  });
});
