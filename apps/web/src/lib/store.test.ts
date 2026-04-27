import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getSelectedSessionId,
  hasStoredSessionSelection,
  useAppStore,
} from "./store";

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  useAppStore.setState({
    selectedAgentId: undefined,
    selectedSessionIds: {},
    drafts: {},
    themeMode: "dark",
    modelDetailsOpen: false,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("session selection helpers", () => {
  it("treats a cleared session as an explicit stored selection", () => {
    expect(hasStoredSessionSelection({ "agent-1": null }, "agent-1")).toBe(
      true
    );
    expect(
      getSelectedSessionId({ "agent-1": null }, "agent-1")
    ).toBeUndefined();
  });

  it("distinguishes missing selection state from a cleared draft chat", () => {
    expect(hasStoredSessionSelection({}, "agent-1")).toBe(false);
    expect(getSelectedSessionId({}, "agent-1")).toBeUndefined();
  });
});

describe("model detail visibility", () => {
  it("starts hidden so the UI stays focused by default", () => {
    expect(useAppStore.getState().modelDetailsOpen).toBe(false);
  });

  it("can persist a visible model details state", () => {
    useAppStore.getState().setModelDetailsOpen(true);

    expect(useAppStore.getState().modelDetailsOpen).toBe(true);
  });
});
