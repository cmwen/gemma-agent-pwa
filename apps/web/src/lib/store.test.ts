import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getSelectedSessionId,
  hasStoredSessionSelection,
  partializeAppStoreState,
  useAppStore,
} from "./store";

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  useAppStore.setState({
    selectedAgentId: undefined,
    selectedSessionIds: {},
    lastScheduledRunNotifications: {},
    drafts: {},
    themeMode: "dark",
    modelDetailsOpen: false,
    notificationsEnabled: false,
    autoPlayReplies: true,
    handsFreeVoiceTurns: true,
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

describe("notification preference", () => {
  it("starts disabled until the user opts in", () => {
    expect(useAppStore.getState().notificationsEnabled).toBe(false);
  });

  it("persists the notification toggle state", () => {
    useAppStore.getState().setNotificationsEnabled(true);

    expect(useAppStore.getState().notificationsEnabled).toBe(true);
  });

  it("tracks which scheduled run was already surfaced", () => {
    useAppStore
      .getState()
      .setLastScheduledRunNotification("schedule-1", "run-1");

    expect(useAppStore.getState().lastScheduledRunNotifications).toEqual({
      "schedule-1": "run-1",
    });
  });
});

describe("speech preferences", () => {
  it("starts with hands-free voice turns enabled", () => {
    expect(useAppStore.getState().handsFreeVoiceTurns).toBe(true);
  });

  it("persists speech playback and hands-free toggles", () => {
    useAppStore.getState().setAutoPlayReplies(false);
    useAppStore.getState().setHandsFreeVoiceTurns(false);

    expect(useAppStore.getState().autoPlayReplies).toBe(false);
    expect(useAppStore.getState().handsFreeVoiceTurns).toBe(false);
  });
});

describe("persisted app state", () => {
  it("omits volatile drafts from persisted storage", () => {
    expect(
      partializeAppStoreState({
        ...useAppStore.getState(),
        drafts: {
          "agent-1:new": "Draft that should stay in memory only.",
        },
        selectedAgentId: "agent-1",
        selectedSessionIds: { "agent-1": "session-1" },
        lastScheduledRunNotifications: { "schedule-1": "run-1" },
        themeMode: "light",
        modelDetailsOpen: true,
        notificationsEnabled: true,
        autoPlayReplies: false,
        handsFreeVoiceTurns: false,
      })
    ).toEqual({
      selectedAgentId: "agent-1",
      selectedSessionIds: { "agent-1": "session-1" },
      lastScheduledRunNotifications: { "schedule-1": "run-1" },
      themeMode: "light",
      modelDetailsOpen: true,
      notificationsEnabled: true,
      autoPlayReplies: false,
      handsFreeVoiceTurns: false,
    });
  });
});
