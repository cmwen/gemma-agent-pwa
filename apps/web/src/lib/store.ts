import { create } from "zustand";
import { persist } from "zustand/middleware";
import { getPreferredTheme, type ThemeMode } from "../app-utils";

interface AppStore {
  selectedAgentId?: string;
  selectedSessionIds: Record<string, string | null>;
  drafts: Record<string, string>;
  themeMode: ThemeMode;
  modelDetailsOpen: boolean;
  setSelectedAgentId: (agentId?: string) => void;
  setSelectedSessionId: (agentId: string, sessionId?: string | null) => void;
  setDraft: (key: string, value: string) => void;
  setThemeMode: (themeMode: ThemeMode) => void;
  setModelDetailsOpen: (modelDetailsOpen: boolean) => void;
}

export const useAppStore = create<AppStore>()(
  persist(
    (set) => ({
      selectedAgentId: undefined,
      selectedSessionIds: {},
      drafts: {},
      themeMode: getPreferredTheme(),
      modelDetailsOpen: false,
      setSelectedAgentId: (agentId) => set({ selectedAgentId: agentId }),
      setSelectedSessionId: (agentId, sessionId) =>
        set((state) => ({
          selectedSessionIds: {
            ...state.selectedSessionIds,
            [agentId]: sessionId ?? null,
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
    }),
    {
      name: "gemma-agent-pwa-state",
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
