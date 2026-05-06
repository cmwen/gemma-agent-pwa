import { create } from "zustand";
import { persist } from "zustand/middleware";
import { getPreferredTheme, type ThemeMode } from "../app-utils";

interface AppStore {
  selectedAgentId?: string;
  selectedSessionIds: Record<string, string | null>;
  lastScheduledRunNotifications: Record<string, string>;
  drafts: Record<string, string>;
  themeMode: ThemeMode;
  modelDetailsOpen: boolean;
  notificationsEnabled: boolean;
  autoPlayReplies: boolean;
  handsFreeVoiceTurns: boolean;
  setSelectedAgentId: (agentId?: string) => void;
  setSelectedSessionId: (agentId: string, sessionId?: string | null) => void;
  setLastScheduledRunNotification: (scheduleId: string, runId: string) => void;
  setDraft: (key: string, value: string) => void;
  setThemeMode: (themeMode: ThemeMode) => void;
  setModelDetailsOpen: (modelDetailsOpen: boolean) => void;
  setNotificationsEnabled: (notificationsEnabled: boolean) => void;
  setAutoPlayReplies: (autoPlayReplies: boolean) => void;
  setHandsFreeVoiceTurns: (handsFreeVoiceTurns: boolean) => void;
}

type PersistedAppStoreState = Pick<
  AppStore,
  | "lastScheduledRunNotifications"
  | "autoPlayReplies"
  | "handsFreeVoiceTurns"
  | "modelDetailsOpen"
  | "notificationsEnabled"
  | "selectedAgentId"
  | "selectedSessionIds"
  | "themeMode"
>;

export function partializeAppStoreState(
  state: AppStore
): PersistedAppStoreState {
  return {
    selectedAgentId: state.selectedAgentId,
    selectedSessionIds: state.selectedSessionIds,
    lastScheduledRunNotifications: state.lastScheduledRunNotifications,
    themeMode: state.themeMode,
    modelDetailsOpen: state.modelDetailsOpen,
    notificationsEnabled: state.notificationsEnabled,
    autoPlayReplies: state.autoPlayReplies,
    handsFreeVoiceTurns: state.handsFreeVoiceTurns,
  };
}

export const useAppStore = create<AppStore>()(
  persist(
    (set) => ({
      selectedAgentId: undefined,
      selectedSessionIds: {},
      lastScheduledRunNotifications: {},
      drafts: {},
      themeMode: getPreferredTheme(),
      modelDetailsOpen: false,
      notificationsEnabled: false,
      autoPlayReplies: true,
      handsFreeVoiceTurns: true,
      setSelectedAgentId: (agentId) => set({ selectedAgentId: agentId }),
      setSelectedSessionId: (agentId, sessionId) =>
        set((state) => ({
          selectedSessionIds: {
            ...state.selectedSessionIds,
            [agentId]: sessionId ?? null,
          },
        })),
      setLastScheduledRunNotification: (scheduleId, runId) =>
        set((state) => ({
          lastScheduledRunNotifications: {
            ...state.lastScheduledRunNotifications,
            [scheduleId]: runId,
          },
        })),
      setDraft: (key, value) =>
        set((state) => ({
          drafts: {
            ...state.drafts,
            [key]: value,
          },
        })),
      setThemeMode: (themeMode) => set({ themeMode }),
      setModelDetailsOpen: (modelDetailsOpen) => set({ modelDetailsOpen }),
      setNotificationsEnabled: (notificationsEnabled) =>
        set({ notificationsEnabled }),
      setAutoPlayReplies: (autoPlayReplies) => set({ autoPlayReplies }),
      setHandsFreeVoiceTurns: (handsFreeVoiceTurns) =>
        set({ handsFreeVoiceTurns }),
    }),
    {
      name: "gemma-agent-pwa-state",
      partialize: partializeAppStoreState,
    }
  )
);

export function hasStoredSessionSelection(
  selectedSessionIds: Record<string, string | null>,
  agentId: string
): boolean {
  return Object.hasOwn(selectedSessionIds, agentId);
}

export function getSelectedSessionId(
  selectedSessionIds: Record<string, string | null>,
  agentId?: string
): string | undefined {
  if (!agentId) {
    return undefined;
  }
  return selectedSessionIds[agentId] ?? undefined;
}

export function buildDraftKey(agentId?: string, sessionId?: string): string {
  return `${agentId ?? "unknown"}:${sessionId ?? "new"}`;
}
