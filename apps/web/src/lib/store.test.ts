import { describe, expect, it } from "vitest";
import { getSelectedSessionId, hasStoredSessionSelection } from "./store";

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
