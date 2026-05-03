import {
  type ChatSession,
  type ChatSessionSummary,
  type ChatStreamEvent,
  type ChatTurn,
  GEMMA_BALANCED_PRESET_ID,
  GEMMA_PRESETS,
  getPresetById,
  type PartialChatRuntimeConfig,
  type ScheduledTask,
  type ScheduledTaskCreate,
  type ScheduledTaskUpdate,
} from "@gemma-agent-pwa/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  applyPresetRuntimeConfig,
  buildAppShellClassName,
  buildCompletionNotification,
  buildDetailPanelClassName,
  buildMessages,
  buildScheduledTaskNotification,
  buildStreamConsoleEntry,
  describeScheduledTask,
  filterCommandItems,
  formatNotificationPermissionLabel,
  formatTime,
  getNewScheduledTaskNotifications,
  getNextFocusableIndex,
  getNextTheme,
  getNotificationPermission,
  getSchedulePollingInterval,
  isEditableElement,
  isNotificationSupported,
  isScrolledNearBottom,
  type StreamSkillActivity,
  shouldBlurActiveEditableElementOnPointerDown,
  shouldSendCompletionNotification,
} from "./app-utils";
import {
  createScheduledTask as createScheduledTaskRequest,
  deleteScheduledTask as deleteScheduledTaskRequest,
  deleteSession as deleteSessionRequest,
  getAgent,
  getAgents,
  getHealth,
  getModels,
  getScheduledTasks,
  getSession,
  getSessions,
  restoreSession as restoreSessionRequest,
  runScheduledTask as runScheduledTaskRequest,
  streamChat,
  updateScheduledTask as updateScheduledTaskRequest,
} from "./lib/api";
import {
  buildDraftKey,
  getSelectedSessionId,
  hasStoredSessionSelection,
  useAppStore,
} from "./lib/store";

interface StreamingState {
  sending: boolean;
  assistantText?: string;
  thinkingText?: string;
  error?: string;
  skillActivities?: StreamSkillActivity[];
}

interface CommandItem {
  id: string;
  label: string;
  description: string;
  group: "Jump" | "Actions";
  keywords: string[];
  shortcut?: string;
  run: () => void;
}

interface StreamConsoleEntryViewModel {
  id: string;
  detail?: string;
  summary: string;
  timestamp: string;
  tone: "info" | "success" | "error";
}

interface ScheduleDraftState {
  title: string;
  prompt: string;
  recurrence: ScheduledTask["recurrence"];
  minuteOfHour: string;
  hourOfDay: string;
  dayOfWeek: string;
  sessionMode: ScheduledTask["sessionMode"];
  notifyOnCompletion: boolean;
  enabled: boolean;
  timezone: string;
}

type MobileSection = "agents" | "history" | "chat" | "details";
type HistoryView = "active" | "deleted";
type SessionAction = "soft-delete" | "restore" | "permanent-delete";
type ResizablePanel = "agents" | "history";

const MOBILE_SECTIONS: Array<{ id: MobileSection; label: string }> = [
  { id: "chat", label: "Chat" },
  { id: "agents", label: "Agents" },
  { id: "history", label: "History" },
  { id: "details", label: "Details" },
];
const DESKTOP_BREAKPOINT = 981;
const DESKTOP_PANEL_GAP = 16;
const MIN_CHAT_PANEL_WIDTH = 420;
const RESIZE_STEP = 24;
const PANEL_WIDTH_LIMITS = {
  agents: {
    defaultWidth: 280,
    min: 220,
    max: 420,
  },
  history: {
    defaultWidth: 280,
    min: 240,
    max: 520,
  },
} as const;
const WEEKDAY_OPTIONS = [
  { label: "Sunday", value: "0" },
  { label: "Monday", value: "1" },
  { label: "Tuesday", value: "2" },
  { label: "Wednesday", value: "3" },
  { label: "Thursday", value: "4" },
  { label: "Friday", value: "5" },
  { label: "Saturday", value: "6" },
] as const;

export default function App() {
  const queryClient = useQueryClient();
  const selectedAgentId = useAppStore((state) => state.selectedAgentId);
  const selectedSessionIds = useAppStore((state) => state.selectedSessionIds);
  const lastScheduledRunNotifications = useAppStore(
    (state) => state.lastScheduledRunNotifications
  );
  const drafts = useAppStore((state) => state.drafts);
  const themeMode = useAppStore((state) => state.themeMode);
  const modelDetailsOpen = useAppStore((state) => state.modelDetailsOpen);
  const notificationsEnabled = useAppStore(
    (state) => state.notificationsEnabled
  );
  const setSelectedAgentId = useAppStore((state) => state.setSelectedAgentId);
  const setSelectedSessionId = useAppStore(
    (state) => state.setSelectedSessionId
  );
  const setLastScheduledRunNotification = useAppStore(
    (state) => state.setLastScheduledRunNotification
  );
  const setDraft = useAppStore((state) => state.setDraft);
  const setThemeMode = useAppStore((state) => state.setThemeMode);
  const setModelDetailsOpen = useAppStore((state) => state.setModelDetailsOpen);
  const setNotificationsEnabled = useAppStore(
    (state) => state.setNotificationsEnabled
  );

  const [runtimeConfig, setRuntimeConfig] = useState<PartialChatRuntimeConfig>(
    {}
  );
  const [runtimeConfigDirty, setRuntimeConfigDirty] = useState(false);
  const [historyView, setHistoryView] = useState<HistoryView>("active");
  const [mobileSection, setMobileSection] = useState<MobileSection>("chat");
  const [isCommandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [isHelpOpen, setHelpOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState("");
  const [commandSelectionIndex, setCommandSelectionIndex] = useState(0);
  const [desktopPanelWidths, setDesktopPanelWidths] = useState<{
    agents: number;
    history: number;
  }>({
    agents: PANEL_WIDTH_LIMITS.agents.defaultWidth,
    history: PANEL_WIDTH_LIMITS.history.defaultWidth,
  });
  const [notificationPermission, setNotificationPermission] = useState(
    getNotificationPermission()
  );
  const [notificationError, setNotificationError] = useState<string>();
  const [scheduleError, setScheduleError] = useState<string>();
  const [scheduleEditorOpen, setScheduleEditorOpen] = useState(false);
  const [scheduleSubmitting, setScheduleSubmitting] = useState(false);
  const [editingScheduleId, setEditingScheduleId] = useState<string>();
  const [isOnline, setIsOnline] = useState(
    typeof navigator === "undefined" ? true : navigator.onLine
  );
  const [isDocumentHidden, setDocumentHidden] = useState(
    typeof document === "undefined" ? false : document.hidden
  );
  const [scheduleDraft, setScheduleDraft] = useState<ScheduleDraftState>(
    createScheduleDraftState()
  );
  const [streaming, setStreaming] = useState<StreamingState>({
    sending: false,
  });
  const [streamConsoleEntries, setStreamConsoleEntries] = useState<
    StreamConsoleEntryViewModel[]
  >([]);
  const [liveThread, setLiveThread] = useState<ChatSession | undefined>();
  const [historyError, setHistoryError] = useState<string>();
  const [pendingSessionAction, setPendingSessionAction] = useState<{
    sessionId: string;
    action: SessionAction;
  }>();
  const abortRef = useRef<AbortController | null>(null);
  const appShellRef = useRef<HTMLDivElement | null>(null);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const newChatButtonRef = useRef<HTMLButtonElement | null>(null);
  const recentHistoryButtonRef = useRef<HTMLButtonElement | null>(null);
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null);
  const chatDetailsToggleRef = useRef<HTMLButtonElement | null>(null);
  const modelDetailsToggleRef = useRef<HTMLButtonElement | null>(null);
  const presetSelectRef = useRef<HTMLSelectElement | null>(null);
  const commandPaletteInputRef = useRef<HTMLInputElement | null>(null);
  const helpCloseButtonRef = useRef<HTMLButtonElement | null>(null);
  const lastFocusedElementRef = useRef<HTMLElement | null>(null);
  const activeResizePanelRef = useRef<ResizablePanel | null>(null);
  const desktopPanelWidthsRef = useRef(desktopPanelWidths);
  const notificationsEnabledRef = useRef(notificationsEnabled);
  const notificationPermissionRef = useRef(notificationPermission);
  const runtimeConfigSourceKeyRef = useRef<string>("");
  const forceAutoScrollTimelineRef = useRef(true);
  const timelineSyncKeyRef = useRef("");
  const timelineMetricsRef = useRef<
    | {
        clientHeight: number;
        scrollHeight: number;
      }
    | undefined
  >(undefined);

  const healthQuery = useQuery({
    queryKey: ["health"],
    queryFn: getHealth,
    refetchInterval: 15_000,
  });
  const modelsQuery = useQuery({
    queryKey: ["models"],
    queryFn: getModels,
    refetchInterval: 30_000,
  });
  const agentsQuery = useQuery({
    queryKey: ["agents"],
    queryFn: getAgents,
  });
  const schedulesQuery = useQuery({
    queryKey: ["scheduled-tasks"],
    queryFn: () => getScheduledTasks(),
    retry: 1,
    refetchInterval: getSchedulePollingInterval({
      documentHidden: isDocumentHidden,
      isOnline,
      notificationsEnabled,
    }),
    refetchIntervalInBackground: notificationsEnabled,
  });

  useEffect(() => {
    if (!selectedAgentId && agentsQuery.data?.[0]) {
      setSelectedAgentId(agentsQuery.data[0].id);
    }
  }, [agentsQuery.data, selectedAgentId, setSelectedAgentId]);

  const selectedAgent = useMemo(
    () => agentsQuery.data?.find((agent) => agent.id === selectedAgentId),
    [agentsQuery.data, selectedAgentId]
  );
  const selectedAgentSchedules = useMemo(
    () =>
      (schedulesQuery.data ?? []).filter(
        (task) => task.agentId === selectedAgentId
      ),
    [schedulesQuery.data, selectedAgentId]
  );
  const pendingScheduleNotifications = useMemo(
    () =>
      getNewScheduledTaskNotifications(
        schedulesQuery.data ?? [],
        lastScheduledRunNotifications
      ),
    [lastScheduledRunNotifications, schedulesQuery.data]
  );

  const agentDetailQuery = useQuery({
    queryKey: ["agent", selectedAgentId],
    queryFn: () => getAgent(selectedAgentId ?? ""),
    enabled: Boolean(selectedAgentId),
  });

  const sessionsQuery = useQuery({
    queryKey: ["sessions", selectedAgentId, historyView],
    queryFn: () => getSessions(selectedAgentId ?? "", historyView),
    enabled: Boolean(selectedAgentId),
  });

  useEffect(() => {
    if (selectedAgentId === undefined) {
      setHistoryView("active");
      setHistoryError(undefined);
      return;
    }
    setHistoryView("active");
    setHistoryError(undefined);
  }, [selectedAgentId]);

  useEffect(() => {
    if (!selectedAgentId) {
      return;
    }
    if (
      historyView === "active" &&
      !hasStoredSessionSelection(selectedSessionIds, selectedAgentId) &&
      sessionsQuery.data?.[0]
    ) {
      setSelectedSessionId(selectedAgentId, sessionsQuery.data[0].sessionId);
    }
  }, [
    selectedAgentId,
    historyView,
    selectedSessionIds,
    sessionsQuery.data,
    setSelectedSessionId,
  ]);

  const activeSessionId = getSelectedSessionId(
    selectedSessionIds,
    selectedAgentId
  );

  const sessionQuery = useQuery({
    queryKey: ["session", selectedAgentId, activeSessionId],
    queryFn: () => getSession(selectedAgentId ?? "", activeSessionId ?? ""),
    enabled: Boolean(selectedAgentId && activeSessionId),
  });

  useEffect(() => {
    if (
      historyView !== "active" ||
      !selectedAgentId ||
      !activeSessionId ||
      !sessionsQuery.data ||
      !sessionQuery.data?.deletedAt
    ) {
      return;
    }
    const isVisibleInActiveList = sessionsQuery.data.some(
      (session) => session.sessionId === activeSessionId
    );
    if (!isVisibleInActiveList) {
      setSelectedSessionId(selectedAgentId, null);
      setLiveThread(undefined);
    }
  }, [
    activeSessionId,
    historyView,
    selectedAgentId,
    sessionQuery.data?.deletedAt,
    sessionsQuery.data,
    setSelectedSessionId,
  ]);

  const thread =
    liveThread?.sessionId === activeSessionId ? liveThread : sessionQuery.data;
  const runtimeConfigSourceKey = `${selectedAgentId ?? "none"}:${thread?.sessionId ?? "new"}`;

  useEffect(() => {
    const agentConfig = agentDetailQuery.data?.runtimeConfig;
    const sessionConfig = thread?.runtimeConfig;
    const fallbackModel =
      modelsQuery.data?.find((model) => /gemma-4/i.test(model.id))?.id ??
      modelsQuery.data?.find((model) => model.isGemma)?.id ??
      modelsQuery.data?.[0]?.id;
    const nextRuntimeConfig = {
      presetId:
        sessionConfig?.presetId ??
        agentConfig?.presetId ??
        GEMMA_BALANCED_PRESET_ID,
      model: sessionConfig?.model ?? agentConfig?.model ?? fallbackModel,
      lmStudioEnableThinking:
        sessionConfig?.lmStudioEnableThinking ??
        agentConfig?.lmStudioEnableThinking,
      maxCompletionTokens:
        sessionConfig?.maxCompletionTokens ?? agentConfig?.maxCompletionTokens,
      contextWindowSize:
        sessionConfig?.contextWindowSize ?? agentConfig?.contextWindowSize,
      temperature: sessionConfig?.temperature ?? agentConfig?.temperature,
      topP: sessionConfig?.topP ?? agentConfig?.topP,
    };
    const sourceChanged =
      runtimeConfigSourceKeyRef.current !== runtimeConfigSourceKey;

    runtimeConfigSourceKeyRef.current = runtimeConfigSourceKey;
    if (sourceChanged) {
      forceAutoScrollTimelineRef.current = true;
      timelineMetricsRef.current = undefined;
      setRuntimeConfigDirty(false);
      setLiveThread(undefined);
      setStreaming({ sending: false, skillActivities: [] });
    }

    if (runtimeConfigDirty && !sourceChanged) {
      return;
    }

    setRuntimeConfig(nextRuntimeConfig);
  }, [
    agentDetailQuery.data,
    modelsQuery.data,
    runtimeConfigDirty,
    runtimeConfigSourceKey,
    thread?.runtimeConfig,
  ]);

  const draftKey = buildDraftKey(selectedAgentId, activeSessionId);
  const draft = drafts[draftKey] ?? "";
  const activePreset = getPresetById(runtimeConfig.presetId);
  const thinkingEnabled =
    runtimeConfig.lmStudioEnableThinking ?? activePreset.lmStudioEnableThinking;
  const modeValue = thinkingEnabled ? "think" : "fast";
  const messages = buildMessages(thread, streaming);
  const timelineSyncKey = `${messages.length}:${streaming.assistantText ?? ""}:${streaming.thinkingText ?? ""}:${streaming.sending ? "1" : "0"}`;
  const status = streaming.sending
    ? "Generating"
    : healthQuery.data?.lmStudioReachable
      ? "Ready"
      : "Offline";
  const selectedModel = modelsQuery.data?.find(
    (model) => model.id === runtimeConfig.model
  );
  const threadDeleted = Boolean(thread?.deletedAt);
  const modelTone = /gemma-4/i.test(runtimeConfig.model ?? "")
    ? "Gemma 4 tuned"
    : selectedModel?.isGemma
      ? "Gemma tuned"
      : "Model fallback";

  const canSend =
    Boolean(selectedAgentId) &&
    draft.trim().length > 0 &&
    !streaming.sending &&
    Boolean(runtimeConfig.model) &&
    !threadDeleted;

  const focusSection = useCallback(
    (section: MobileSection, options?: { focusTarget?: boolean }) => {
      if (section === "details" && !modelDetailsOpen) {
        setModelDetailsOpen(true);
      }
      setMobileSection(section);
      if (options?.focusTarget === false) {
        return;
      }
      requestAnimationFrame(() => {
        switch (section) {
          case "agents":
            newChatButtonRef.current?.focus();
            break;
          case "history":
            recentHistoryButtonRef.current?.focus();
            break;
          case "chat":
            composerInputRef.current?.focus();
            break;
          case "details":
            modelDetailsToggleRef.current?.focus();
            break;
        }
      });
    },
    [modelDetailsOpen, setModelDetailsOpen]
  );
  const openCommandPalette = useCallback(() => {
    lastFocusedElementRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setHelpOpen(false);
    setCommandQuery("");
    setCommandPaletteOpen(true);
  }, []);
  const closeCommandPalette = useCallback(
    (options?: { restoreFocus?: boolean }) => {
      setCommandPaletteOpen(false);
      setCommandQuery("");
      if (options?.restoreFocus === false) {
        return;
      }
      requestAnimationFrame(() => lastFocusedElementRef.current?.focus());
    },
    []
  );
  const openHelpDialog = useCallback(() => {
    lastFocusedElementRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setCommandPaletteOpen(false);
    setHelpOpen(true);
  }, []);
  const closeHelpDialog = useCallback(
    (options?: { restoreFocus?: boolean }) => {
      setHelpOpen(false);
      if (options?.restoreFocus === false) {
        return;
      }
      requestAnimationFrame(() => lastFocusedElementRef.current?.focus());
    },
    []
  );
  const commandItems: CommandItem[] = [
    {
      id: "jump-chat",
      label: "Go to chat",
      description: "Focus the active conversation and composer.",
      group: "Jump",
      keywords: ["chat", "composer", "conversation"],
      shortcut: "Alt+1",
      run: () => focusSection("chat"),
    },
    {
      id: "jump-agents",
      label: "Go to agents",
      description: "Browse the installed local agents.",
      group: "Jump",
      keywords: ["agents", "sidebar", "navigation"],
      shortcut: "Alt+2",
      run: () => focusSection("agents"),
    },
    {
      id: "jump-history",
      label: "Go to history",
      description: "Review recent and deleted chats.",
      group: "Jump",
      keywords: ["history", "sessions", "trash"],
      shortcut: "Alt+3",
      run: () => focusSection("history"),
    },
    {
      id: "jump-details",
      label: "Go to details",
      description: "Inspect agent status and runtime settings.",
      group: "Jump",
      keywords: ["details", "settings", "status"],
      shortcut: "Alt+4",
      run: () => focusSection("details"),
    },
    {
      id: "new-chat",
      label: "Start new chat",
      description: "Clear the current thread for the selected agent.",
      group: "Actions",
      keywords: ["new", "chat", "thread"],
      shortcut: "N",
      run: () => handleNewChat(),
    },
    {
      id: "open-schedules",
      label: "Manage scheduled tasks",
      description:
        "Open the details rail and create or edit recurring hourly, daily, and weekly tasks.",
      group: "Actions",
      keywords: ["schedule", "scheduled", "tasks", "automation", "reminders"],
      run: () => openScheduleEditor(),
    },
    {
      id: "open-help",
      label: "Show shortcuts and help",
      description: "Open the keyboard shortcut list and quick usage tips.",
      group: "Actions",
      keywords: ["help", "shortcuts", "keyboard", "tips"],
      shortcut: "?",
      run: () => openHelpDialog(),
    },
    {
      id: "toggle-history-view",
      label:
        historyView === "active"
          ? "Show deleted history"
          : "Show recent history",
      description:
        historyView === "active"
          ? "Switch the history rail to Trash."
          : "Switch the history rail back to recent chats.",
      group: "Actions",
      keywords: ["history", "trash", "recent", "deleted"],
      run: () =>
        setHistoryView((current) =>
          current === "active" ? "deleted" : "active"
        ),
    },
    {
      id: "toggle-model-details",
      label: modelDetailsOpen ? "Hide details panel" : "Show details panel",
      description:
        "Toggle the full details rail, including console logs and model settings.",
      group: "Actions",
      keywords: ["agent", "details", "model", "status", "console", "settings"],
      run: () => handleModelDetailsToggle(!modelDetailsOpen),
    },
    {
      id: "toggle-theme",
      label:
        themeMode === "dark" ? "Switch to light theme" : "Switch to dark theme",
      description: "Flip the app theme and persist it locally.",
      group: "Actions",
      keywords: ["theme", "light", "dark", "appearance"],
      run: () => handleThemeToggle(),
    },
    {
      id: "toggle-notifications",
      label: notificationsEnabled
        ? "Disable reply notifications"
        : "Enable reply notifications",
      description:
        notificationPermission === "granted"
          ? "Toggle browser notifications for completed background replies."
          : "Request browser permission for completed background reply notifications.",
      group: "Actions",
      keywords: ["notifications", "notify", "alerts", "background", "pwa"],
      run: () => void handleNotificationsToggle(),
    },
  ];
  const visibleCommandItems = filterCommandItems(commandItems, commandQuery);
  const groupedCommandItems = (["Jump", "Actions"] as const)
    .map(
      (group) =>
        [
          group,
          visibleCommandItems.filter((command) => command.group === group),
        ] as const
    )
    .filter(([, commands]) => commands.length > 0);
  const selectedCommand = visibleCommandItems[commandSelectionIndex];

  useEffect(() => {
    desktopPanelWidthsRef.current = desktopPanelWidths;
  }, [desktopPanelWidths]);

  useEffect(() => {
    notificationsEnabledRef.current = notificationsEnabled;
  }, [notificationsEnabled]);

  useEffect(() => {
    notificationPermissionRef.current = notificationPermission;
  }, [notificationPermission]);

  const appendConsoleEntry = useCallback(
    (entry: StreamConsoleEntryViewModel | undefined): void => {
      if (!entry) {
        return;
      }
      setStreamConsoleEntries((current) => [...current, entry]);
    },
    []
  );

  const showScheduledTaskNotification = useCallback(
    async (task: ScheduledTask, agentTitle?: string) => {
      const icon = new URL(
        `${import.meta.env.BASE_URL}favicon.svg`,
        window.location.origin
      ).toString();
      const notification = buildScheduledTaskNotification({
        agentTitle,
        task,
      });

      if ("serviceWorker" in navigator) {
        const registration = await navigator.serviceWorker.getRegistration();
        if (registration?.showNotification) {
          await registration.showNotification(notification.title, {
            badge: icon,
            body: notification.body,
            icon,
            tag: notification.tag,
          });
          return;
        }
      }

      if (!isNotificationSupported()) {
        throw new Error("This browser does not support notifications.");
      }

      new Notification(notification.title, {
        body: notification.body,
        icon,
        tag: notification.tag,
      });
    },
    []
  );

  useEffect(() => {
    const timeline = timelineRef.current;
    if (!timeline) {
      return;
    }
    timelineSyncKeyRef.current = timelineSyncKey;
    const previousMetrics = timelineMetricsRef.current;
    const shouldFollowLatest =
      forceAutoScrollTimelineRef.current ||
      !previousMetrics ||
      isScrolledNearBottom({
        clientHeight: previousMetrics.clientHeight,
        scrollHeight: previousMetrics.scrollHeight,
        scrollTop: timeline.scrollTop,
      });

    if (shouldFollowLatest) {
      timeline.scrollTop = timeline.scrollHeight;
    }

    forceAutoScrollTimelineRef.current = false;
    timelineMetricsRef.current = {
      clientHeight: timeline.clientHeight,
      scrollHeight: timeline.scrollHeight,
    };
  }, [timelineSyncKey]);

  useEffect(() => {
    document.documentElement.dataset.theme = themeMode;
  }, [themeMode]);

  useEffect(() => {
    function syncEnvironment() {
      setDocumentHidden(document.hidden);
      setIsOnline(navigator.onLine);
    }

    syncEnvironment();
    window.addEventListener("online", syncEnvironment);
    window.addEventListener("offline", syncEnvironment);
    window.addEventListener("focus", syncEnvironment);
    document.addEventListener("visibilitychange", syncEnvironment);
    return () => {
      window.removeEventListener("online", syncEnvironment);
      window.removeEventListener("offline", syncEnvironment);
      window.removeEventListener("focus", syncEnvironment);
      document.removeEventListener("visibilitychange", syncEnvironment);
    };
  }, []);

  useEffect(() => {
    function syncNotificationPermission() {
      setNotificationPermission(getNotificationPermission());
    }

    syncNotificationPermission();
    window.addEventListener("focus", syncNotificationPermission);
    document.addEventListener("visibilitychange", syncNotificationPermission);
    return () => {
      window.removeEventListener("focus", syncNotificationPermission);
      document.removeEventListener(
        "visibilitychange",
        syncNotificationPermission
      );
    };
  }, []);

  useEffect(() => {
    if (notificationPermission === "granted") {
      setNotificationError(undefined);
      return;
    }

    if (notificationsEnabled) {
      setNotificationsEnabled(false);
    }
  }, [notificationPermission, notificationsEnabled, setNotificationsEnabled]);

  useEffect(() => {
    const badgeCount = pendingScheduleNotifications.length;
    if (
      "setAppBadge" in navigator &&
      typeof navigator.setAppBadge === "function"
    ) {
      void navigator.setAppBadge(badgeCount).catch(() => {});
    } else if (
      badgeCount === 0 &&
      "clearAppBadge" in navigator &&
      typeof navigator.clearAppBadge === "function"
    ) {
      void navigator.clearAppBadge().catch(() => {});
    }

    if (
      pendingScheduleNotifications.length === 0 ||
      !shouldSendCompletionNotification({
        notificationsEnabled,
        permission: notificationPermission,
        documentHidden: document.hidden,
        windowHasFocus: document.hasFocus(),
      })
    ) {
      return;
    }

    pendingScheduleNotifications.forEach((task) => {
      const latestRun = task.recentRuns[0];
      if (!latestRun) {
        return;
      }
      const agentTitle = agentsQuery.data?.find(
        (agent) => agent.id === task.agentId
      )?.title;
      void showScheduledTaskNotification(task, agentTitle)
        .then(() => {
          setLastScheduledRunNotification(task.id, latestRun.runId);
        })
        .catch((error) => {
          const message =
            error instanceof Error ? error.message : "Notification failed.";
          setNotificationError(message);
          appendConsoleEntry({
            id: `${new Date().toISOString()}-schedule-notification-error`,
            summary: "Schedule notification error",
            detail: message,
            timestamp: new Date().toISOString(),
            tone: "error",
          });
        });
    });
  }, [
    appendConsoleEntry,
    agentsQuery.data,
    notificationPermission,
    notificationsEnabled,
    pendingScheduleNotifications,
    setLastScheduledRunNotification,
    showScheduledTaskNotification,
  ]);

  useEffect(() => {
    if (!isCommandPaletteOpen) {
      return;
    }
    requestAnimationFrame(() => commandPaletteInputRef.current?.focus());
  }, [isCommandPaletteOpen]);

  useEffect(() => {
    if (!isHelpOpen) {
      return;
    }
    requestAnimationFrame(() => helpCloseButtonRef.current?.focus());
  }, [isHelpOpen]);

  useEffect(() => {
    if (!isCommandPaletteOpen) {
      setCommandSelectionIndex(0);
      return;
    }
    setCommandSelectionIndex((current) => {
      if (visibleCommandItems.length === 0) {
        return 0;
      }
      return Math.min(current, visibleCommandItems.length - 1);
    });
  }, [isCommandPaletteOpen, visibleCommandItems.length]);

  const getDesktopDetailWidth = useCallback(
    () => (window.innerWidth <= 1280 ? 280 : 320),
    []
  );
  const clampDesktopPanelWidth = useCallback(
    (
      panel: ResizablePanel,
      nextWidth: number,
      widths = desktopPanelWidthsRef.current
    ) => {
      const limits = PANEL_WIDTH_LIMITS[panel];
      let maxWidth: number = limits.max;
      const shellWidth = appShellRef.current?.clientWidth;
      if (shellWidth) {
        const otherPanelWidth =
          panel === "agents" ? widths.history : widths.agents;
        const detailWidth = modelDetailsOpen ? getDesktopDetailWidth() : 0;
        const gapCount = modelDetailsOpen ? 3 : 2;
        const availableWidth =
          shellWidth -
          otherPanelWidth -
          detailWidth -
          MIN_CHAT_PANEL_WIDTH -
          gapCount * DESKTOP_PANEL_GAP;
        maxWidth = Math.min(maxWidth, availableWidth);
      }
      return Math.min(
        Math.max(Math.round(nextWidth), limits.min),
        Math.max(limits.min, maxWidth)
      );
    },
    [getDesktopDetailWidth, modelDetailsOpen]
  );
  const normalizeDesktopPanelWidths = useCallback(
    (widths: typeof desktopPanelWidths) => {
      const agents = clampDesktopPanelWidth("agents", widths.agents, widths);
      const history = clampDesktopPanelWidth("history", widths.history, {
        ...widths,
        agents,
      });
      return { agents, history };
    },
    [clampDesktopPanelWidth]
  );
  const updateDesktopPanelWidth = useCallback(
    (panel: ResizablePanel, nextWidth: number) => {
      setDesktopPanelWidths((current) => {
        const normalized = normalizeDesktopPanelWidths({
          ...current,
          [panel]: clampDesktopPanelWidth(panel, nextWidth, current),
        });
        return normalized.agents === current.agents &&
          normalized.history === current.history
          ? current
          : normalized;
      });
    },
    [clampDesktopPanelWidth, normalizeDesktopPanelWidths]
  );

  useEffect(() => {
    function syncDesktopPanelWidths() {
      if (
        typeof window === "undefined" ||
        window.innerWidth < DESKTOP_BREAKPOINT
      ) {
        return;
      }
      setDesktopPanelWidths((current) => {
        const normalized = normalizeDesktopPanelWidths(current);
        return normalized.agents === current.agents &&
          normalized.history === current.history
          ? current
          : normalized;
      });
    }

    syncDesktopPanelWidths();
    window.addEventListener("resize", syncDesktopPanelWidths);
    return () => window.removeEventListener("resize", syncDesktopPanelWidths);
  }, [normalizeDesktopPanelWidths]);

  useEffect(() => {
    function stopPanelResize() {
      if (!activeResizePanelRef.current) {
        return;
      }
      activeResizePanelRef.current = null;
      document.body.classList.remove("is-resizing-panels");
    }

    function handlePointerMove(event: PointerEvent) {
      if (
        !activeResizePanelRef.current ||
        !appShellRef.current ||
        window.innerWidth < DESKTOP_BREAKPOINT
      ) {
        return;
      }
      const shellBounds = appShellRef.current.getBoundingClientRect();
      const pointerOffset = event.clientX - shellBounds.left;
      if (activeResizePanelRef.current === "agents") {
        updateDesktopPanelWidth("agents", pointerOffset);
        return;
      }
      updateDesktopPanelWidth(
        "history",
        pointerOffset - desktopPanelWidthsRef.current.agents - DESKTOP_PANEL_GAP
      );
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopPanelResize);
    window.addEventListener("pointercancel", stopPanelResize);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopPanelResize);
      window.removeEventListener("pointercancel", stopPanelResize);
      document.body.classList.remove("is-resizing-panels");
    };
  }, [updateDesktopPanelWidth]);

  function handleAppShellPointerDownCapture(
    event: ReactPointerEvent<HTMLDivElement>
  ) {
    if (
      isCommandPaletteOpen ||
      isHelpOpen ||
      !shouldBlurActiveEditableElementOnPointerDown({
        activeElement: document.activeElement,
        desktopBreakpoint: DESKTOP_BREAKPOINT,
        pointerType: event.pointerType,
        target: event.target,
        viewportWidth: window.innerWidth,
      })
    ) {
      return;
    }

    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  }

  function handleTimelinePointerDownCapture(
    event: ReactPointerEvent<HTMLDivElement>
  ) {
    forceAutoScrollTimelineRef.current = false;
    if (
      event.pointerType === "touch" &&
      window.innerWidth < DESKTOP_BREAKPOINT &&
      document.activeElement instanceof HTMLElement &&
      isEditableElement(document.activeElement)
    ) {
      document.activeElement.blur();
    }
  }

  function handleThemeToggle() {
    setThemeMode(getNextTheme(themeMode));
  }

  function updateRuntimeConfigState(
    updater:
      | PartialChatRuntimeConfig
      | ((current: PartialChatRuntimeConfig) => PartialChatRuntimeConfig)
  ) {
    setRuntimeConfigDirty(true);
    setRuntimeConfig(updater);
  }

  async function handleNotificationsToggle() {
    if (notificationsEnabled) {
      setNotificationsEnabled(false);
      setNotificationError(undefined);
      return;
    }

    if (!isNotificationSupported()) {
      setNotificationPermission("unsupported");
      setNotificationError("This browser does not support notifications.");
      return;
    }

    if (notificationPermissionRef.current === "denied") {
      setNotificationError(
        "Notifications are blocked for this site. Allow them in your browser settings, then try again."
      );
      return;
    }

    const nextPermission =
      notificationPermissionRef.current === "granted"
        ? "granted"
        : await Notification.requestPermission();

    setNotificationPermission(nextPermission);

    if (nextPermission !== "granted") {
      setNotificationsEnabled(false);
      setNotificationError(
        nextPermission === "denied"
          ? "Notifications are blocked for this site. Allow them in your browser settings, then try again."
          : "Notification permission was not granted."
      );
      return;
    }

    setNotificationsEnabled(true);
    setNotificationError(undefined);
  }

  async function showCompletionNotification(thread: ChatSession) {
    const icon = new URL(
      `${import.meta.env.BASE_URL}favicon.svg`,
      window.location.origin
    ).toString();
    const notification = buildCompletionNotification({
      agentTitle: selectedAgent?.title,
      assistantMarkdown: thread.turns.at(-1)?.bodyMarkdown,
      sessionId: thread.sessionId,
      sessionTitle: thread.title,
    });

    if ("serviceWorker" in navigator) {
      const registration = await navigator.serviceWorker.getRegistration();
      if (registration?.showNotification) {
        await registration.showNotification(notification.title, {
          badge: icon,
          body: notification.body,
          icon,
          tag: notification.tag,
        });
        return;
      }
    }

    if (!isNotificationSupported()) {
      throw new Error("This browser does not support notifications.");
    }

    new Notification(notification.title, {
      body: notification.body,
      icon,
      tag: notification.tag,
    });
  }

  function maybeNotifyOnCompletion(thread: ChatSession) {
    if (
      !shouldSendCompletionNotification({
        notificationsEnabled: notificationsEnabledRef.current,
        permission: notificationPermissionRef.current,
        documentHidden: document.hidden,
        windowHasFocus: document.hasFocus(),
      })
    ) {
      return;
    }

    void showCompletionNotification(thread).catch((error) => {
      const message =
        error instanceof Error ? error.message : "Notification failed.";
      setNotificationError(message);
      appendConsoleEntry({
        id: `${new Date().toISOString()}-notification-error`,
        summary: "Notification error",
        detail: message,
        timestamp: new Date().toISOString(),
        tone: "error",
      });
    });
  }

  function openScheduleEditor(task?: ScheduledTask) {
    setScheduleError(undefined);
    setEditingScheduleId(task?.id);
    setScheduleDraft(
      task ? createScheduleDraftState(task) : createScheduleDraftState()
    );
    setScheduleEditorOpen(true);
    focusSection("details", { focusTarget: false });
  }

  function closeScheduleEditor() {
    setScheduleEditorOpen(false);
    setEditingScheduleId(undefined);
    setScheduleDraft(createScheduleDraftState());
  }

  function updateScheduleDraft<Field extends keyof ScheduleDraftState>(
    field: Field,
    value: ScheduleDraftState[Field]
  ) {
    setScheduleDraft((current) => ({
      ...current,
      [field]: value,
    }));
  }

  async function handleScheduleSubmit() {
    if (!selectedAgentId) {
      return;
    }

    setScheduleSubmitting(true);
    setScheduleError(undefined);

    const payload = buildScheduledTaskPayload(selectedAgentId, scheduleDraft);

    try {
      if (editingScheduleId) {
        await updateScheduledTaskRequest(
          selectedAgentId,
          editingScheduleId,
          payload as ScheduledTaskUpdate
        );
      } else {
        await createScheduledTaskRequest(
          selectedAgentId,
          payload as ScheduledTaskCreate
        );
      }
      await queryClient.invalidateQueries({
        queryKey: ["scheduled-tasks"],
      });
      closeScheduleEditor();
    } catch (error) {
      setScheduleError(
        error instanceof Error ? error.message : "Schedule update failed."
      );
    } finally {
      setScheduleSubmitting(false);
    }
  }

  async function handleScheduledTaskRun(task: ScheduledTask) {
    if (!selectedAgentId) {
      return;
    }
    setScheduleError(undefined);
    try {
      await runScheduledTaskRequest(selectedAgentId, task.id);
      await queryClient.invalidateQueries({
        queryKey: ["scheduled-tasks"],
      });
    } catch (error) {
      setScheduleError(
        error instanceof Error ? error.message : "Scheduled run failed."
      );
    }
  }

  async function handleScheduledTaskToggle(task: ScheduledTask) {
    if (!selectedAgentId) {
      return;
    }
    setScheduleError(undefined);
    try {
      await updateScheduledTaskRequest(selectedAgentId, task.id, {
        enabled: !task.enabled,
      });
      await queryClient.invalidateQueries({
        queryKey: ["scheduled-tasks"],
      });
    } catch (error) {
      setScheduleError(
        error instanceof Error ? error.message : "Schedule update failed."
      );
    }
  }

  async function handleScheduledTaskDelete(task: ScheduledTask) {
    if (!selectedAgentId) {
      return;
    }
    const confirmed = window.confirm(
      `Delete the scheduled task "${task.title}"?`
    );
    if (!confirmed) {
      return;
    }
    setScheduleError(undefined);
    try {
      await deleteScheduledTaskRequest(selectedAgentId, task.id);
      await queryClient.invalidateQueries({
        queryKey: ["scheduled-tasks"],
      });
      if (editingScheduleId === task.id) {
        closeScheduleEditor();
      }
    } catch (error) {
      setScheduleError(
        error instanceof Error ? error.message : "Schedule deletion failed."
      );
    }
  }

  function startPanelResize(
    panel: ResizablePanel,
    event: ReactPointerEvent<HTMLButtonElement>
  ) {
    if (window.innerWidth < DESKTOP_BREAKPOINT) {
      return;
    }
    event.preventDefault();
    activeResizePanelRef.current = panel;
    document.body.classList.add("is-resizing-panels");
  }

  function handlePanelResizerKeyDown(
    panel: ResizablePanel,
    event: ReactKeyboardEvent<HTMLButtonElement>
  ) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
      return;
    }
    event.preventDefault();
    const delta = event.key === "ArrowLeft" ? -RESIZE_STEP : RESIZE_STEP;
    updateDesktopPanelWidth(
      panel,
      desktopPanelWidthsRef.current[panel] + delta
    );
  }

  function handleModelDetailsToggle(nextOpen: boolean) {
    setModelDetailsOpen(nextOpen);
    if (nextOpen) {
      setMobileSection("details");
      requestAnimationFrame(() => presetSelectRef.current?.focus());
      return;
    }
    setMobileSection("chat");
    requestAnimationFrame(() => chatDetailsToggleRef.current?.focus());
  }

  function handleCommandSelection(command: CommandItem) {
    closeCommandPalette({ restoreFocus: false });
    command.run();
  }

  function handleCommandPaletteKeyDown(
    event: ReactKeyboardEvent<HTMLInputElement>
  ) {
    const nextIndex = getNextFocusableIndex(
      commandSelectionIndex,
      visibleCommandItems.length,
      event.key,
      "vertical"
    );
    if (nextIndex !== undefined) {
      event.preventDefault();
      setCommandSelectionIndex(nextIndex);
      return;
    }
    if (event.key !== "Enter" || !selectedCommand) {
      return;
    }
    event.preventDefault();
    handleCommandSelection(selectedCommand);
  }

  function handleArrowKeyNavigation(
    event: ReactKeyboardEvent<HTMLElement>,
    orientation: "horizontal" | "vertical"
  ) {
    const buttons = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(
        '[data-roving-focus="true"]:not(:disabled)'
      )
    );
    if (buttons.length === 0) {
      return;
    }
    const activeButton =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const nextIndex = getNextFocusableIndex(
      activeButton ? buttons.indexOf(activeButton) : -1,
      buttons.length,
      event.key,
      orientation
    );
    if (nextIndex === undefined) {
      return;
    }
    event.preventDefault();
    buttons[nextIndex]?.focus();
  }

  function handleSiblingArrowKeyNavigation(
    event: ReactKeyboardEvent<HTMLElement>,
    orientation: "horizontal" | "vertical"
  ) {
    const container = event.currentTarget.parentElement;
    if (!container) {
      return;
    }
    const buttons = Array.from(
      container.querySelectorAll<HTMLElement>(
        '[data-roving-focus="true"]:not(:disabled)'
      )
    );
    if (buttons.length === 0) {
      return;
    }
    const nextIndex = getNextFocusableIndex(
      buttons.indexOf(event.currentTarget),
      buttons.length,
      event.key,
      orientation
    );
    if (nextIndex === undefined) {
      return;
    }
    event.preventDefault();
    buttons[nextIndex]?.focus();
  }

  function isAbortError(error: unknown): boolean {
    return error instanceof DOMException && error.name === "AbortError";
  }

  useEffect(() => {
    function handleGlobalKeydown(event: globalThis.KeyboardEvent) {
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === "k"
      ) {
        event.preventDefault();
        if (isCommandPaletteOpen) {
          closeCommandPalette();
        } else {
          openCommandPalette();
        }
        return;
      }
      if (event.key === "Escape" && isCommandPaletteOpen) {
        event.preventDefault();
        closeCommandPalette();
        return;
      }
      if (event.key === "Escape" && isHelpOpen) {
        event.preventDefault();
        closeHelpDialog();
        return;
      }
      if (isEditableElement(event.target)) {
        return;
      }
      if (isCommandPaletteOpen || isHelpOpen) {
        return;
      }
      if (
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        event.key === "?"
      ) {
        event.preventDefault();
        openHelpDialog();
        return;
      }
      if (
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        event.key === "/"
      ) {
        event.preventDefault();
        focusSection("chat");
        return;
      }
      if (event.metaKey || event.ctrlKey || event.shiftKey || !event.altKey) {
        return;
      }
      const section = MOBILE_SECTIONS[Number(event.key) - 1]?.id;
      if (!section) {
        return;
      }
      event.preventDefault();
      focusSection(section);
    }

    window.addEventListener("keydown", handleGlobalKeydown);
    return () => window.removeEventListener("keydown", handleGlobalKeydown);
  }, [
    closeCommandPalette,
    closeHelpDialog,
    focusSection,
    isCommandPaletteOpen,
    isHelpOpen,
    openCommandPalette,
    openHelpDialog,
  ]);

  async function handleSend() {
    if (!selectedAgentId || !draft.trim() || threadDeleted) {
      return;
    }
    forceAutoScrollTimelineRef.current = true;
    if (
      typeof window !== "undefined" &&
      window.innerWidth < DESKTOP_BREAKPOINT &&
      document.activeElement instanceof HTMLElement &&
      isEditableElement(document.activeElement)
    ) {
      document.activeElement.blur();
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setStreamConsoleEntries([]);
    setStreaming({
      sending: true,
      skillActivities: [],
    });

    const prompt = draft.trim();
    setDraft(draftKey, "");

    try {
      await streamChat(
        selectedAgentId,
        {
          sessionId: activeSessionId,
          title: thread?.title ?? prompt,
          prompt,
          config: runtimeConfig,
        },
        {
          signal: controller.signal,
          thread,
          onEvent: (event) => {
            appendConsoleEntry(buildStreamConsoleEntry(event));
            switch (event.type) {
              case "thread":
                setLiveThread(event.thread);
                if (!activeSessionId) {
                  setSelectedSessionId(selectedAgentId, event.thread.sessionId);
                }
                break;
              case "assistant_snapshot":
                setStreaming((state) => ({
                  ...state,
                  assistantText: event.assistantText,
                  thinkingText: event.thinkingText,
                }));
                break;
              case "skill_call":
                setStreaming((state) => ({
                  ...state,
                  assistantText: undefined,
                  thinkingText: undefined,
                  skillActivities: [
                    ...(state.skillActivities ?? []),
                    {
                      id:
                        event.skillCallId ??
                        `${event.skillName}-${Date.now()}-${(state.skillActivities ?? []).length}`,
                      skillInput: event.skillInput,
                      skillName: event.skillName,
                    },
                  ],
                }));
                break;
              case "skill_result":
                setStreaming((state) => ({
                  ...state,
                  assistantText: undefined,
                  thinkingText: undefined,
                  skillActivities: resolveSkillActivities(
                    state.skillActivities ?? [],
                    event
                  ),
                }));
                break;
              case "complete":
                setLiveThread(event.response.thread);
                setSelectedSessionId(
                  selectedAgentId,
                  event.response.thread.sessionId
                );
                void queryClient.invalidateQueries({
                  queryKey: ["sessions", selectedAgentId],
                });
                void queryClient.invalidateQueries({
                  queryKey: [
                    "session",
                    selectedAgentId,
                    event.response.thread.sessionId,
                  ],
                });
                setStreaming((state) => ({
                  sending: false,
                  skillActivities: state.skillActivities ?? [],
                }));
                maybeNotifyOnCompletion(event.response.thread);
                break;
              case "error":
                setStreaming({
                  sending: false,
                  error: event.error,
                  skillActivities: [],
                });
                setDraft(draftKey, prompt);
                break;
            }
          },
        }
      );
    } catch (error) {
      if (isAbortError(error)) {
        return;
      }
      appendConsoleEntry(
        buildStreamConsoleEntry({
          type: "error",
          error: error instanceof Error ? error.message : "Unknown error.",
        })
      );
      setStreaming({
        sending: false,
        error: error instanceof Error ? error.message : "Unknown error.",
        skillActivities: [],
      });
      setDraft(draftKey, prompt);
    } finally {
      abortRef.current = null;
    }
  }

  function handleStop() {
    abortRef.current?.abort();
    abortRef.current = null;
    appendConsoleEntry({
      id: `${new Date().toISOString()}-stopped`,
      summary: "Generation stopped",
      timestamp: new Date().toISOString(),
      tone: "error",
    });
    setStreaming({
      sending: false,
      error: "Generation stopped.",
      skillActivities: [],
    });
  }

  function handleNewChat() {
    if (!selectedAgentId) {
      return;
    }
    forceAutoScrollTimelineRef.current = true;
    timelineMetricsRef.current = undefined;
    abortRef.current?.abort();
    abortRef.current = null;
    setSelectedSessionId(selectedAgentId, null);
    setLiveThread(undefined);
    setStreamConsoleEntries([]);
    setStreaming({ sending: false, skillActivities: [] });
    setMobileSection("chat");
  }

  function handleModeChange(nextMode: "fast" | "think") {
    updateRuntimeConfigState((current) => ({
      ...current,
      presetId: current.presetId ?? GEMMA_BALANCED_PRESET_ID,
      lmStudioEnableThinking: nextMode === "think",
    }));
  }

  async function handleSessionAction(
    session: ChatSessionSummary,
    action: SessionAction
  ) {
    if (!selectedAgentId) {
      return;
    }

    const confirmed = confirmSessionAction(session, action);
    if (!confirmed) {
      return;
    }

    setHistoryError(undefined);
    setPendingSessionAction({
      sessionId: session.sessionId,
      action,
    });
    try {
      if (action === "restore") {
        await restoreSessionRequest(selectedAgentId, session.sessionId);
        setSelectedSessionId(selectedAgentId, session.sessionId);
        setHistoryView("active");
      } else {
        if (activeSessionId === session.sessionId) {
          abortRef.current?.abort();
          abortRef.current = null;
        }
        await deleteSessionRequest(
          selectedAgentId,
          session.sessionId,
          action === "soft-delete" ? "soft" : "permanent"
        );
        if (activeSessionId === session.sessionId) {
          setSelectedSessionId(selectedAgentId, null);
          setLiveThread(undefined);
          setStreaming({ sending: false, skillActivities: [] });
          setMobileSection("history");
        }
      }

      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["sessions", selectedAgentId],
        }),
        queryClient.invalidateQueries({
          queryKey: ["session", selectedAgentId, session.sessionId],
        }),
        queryClient.invalidateQueries({
          queryKey: ["agents"],
        }),
        queryClient.invalidateQueries({
          queryKey: ["agent", selectedAgentId],
        }),
      ]);
    } catch (error) {
      setHistoryError(
        error instanceof Error ? error.message : "Session action failed."
      );
    } finally {
      setPendingSessionAction(undefined);
    }
  }

  function renderSessionActionButtons(session: ChatSessionSummary) {
    if (session.deletedAt) {
      return (
        <>
          <button
            className="secondary-button session-action-button"
            disabled={Boolean(pendingSessionAction)}
            onClick={() => void handleSessionAction(session, "restore")}
            type="button"
          >
            {pendingSessionAction?.sessionId === session.sessionId &&
            pendingSessionAction.action === "restore"
              ? "Restoring..."
              : "Restore"}
          </button>
          <button
            className="danger-button session-action-button"
            disabled={Boolean(pendingSessionAction)}
            onClick={() =>
              void handleSessionAction(session, "permanent-delete")
            }
            type="button"
          >
            {pendingSessionAction?.sessionId === session.sessionId &&
            pendingSessionAction.action === "permanent-delete"
              ? "Deleting..."
              : "Delete forever"}
          </button>
        </>
      );
    }

    return (
      <button
        className="secondary-button session-action-button"
        disabled={Boolean(pendingSessionAction)}
        onClick={() => void handleSessionAction(session, "soft-delete")}
        type="button"
      >
        {pendingSessionAction?.sessionId === session.sessionId &&
        pendingSessionAction.action === "soft-delete"
          ? "Moving..."
          : "Move to Trash"}
      </button>
    );
  }

  const desktopShellStyle = useMemo(
    () =>
      ({
        "--agents-panel-width": `${desktopPanelWidths.agents}px`,
        "--history-panel-width": `${desktopPanelWidths.history}px`,
      }) as CSSProperties,
    [desktopPanelWidths]
  );

  return (
    <div
      className={buildAppShellClassName(modelDetailsOpen)}
      onPointerDownCapture={handleAppShellPointerDownCapture}
      ref={appShellRef}
      style={desktopShellStyle}
    >
      <div className="app-toolbar">
        <div className="toolbar-brand">
          <span className="toolbar-brand-title">Gemma Agent PWA</span>
          <p className="toolbar-brand-copy">
            Local-first chat, quick actions, and everything else tucked behind
            help when you need it.
          </p>
        </div>
        <button
          aria-expanded={isCommandPaletteOpen}
          aria-haspopup="dialog"
          className="command-trigger"
          onClick={openCommandPalette}
          type="button"
        >
          <span className="command-trigger-copy">
            <span className="command-trigger-title">Quick actions</span>
            <span className="command-trigger-subtitle">
              Jump panels, switch history views, and toggle details.
            </span>
          </span>
          <kbd>Ctrl/Cmd+K</kbd>
        </button>
        <div className="toolbar-actions">
          <span className={`status-chip status-${status.toLowerCase()}`}>
            {status}
          </span>
          <IconButton label="Open shortcuts and help" onClick={openHelpDialog}>
            <HelpIcon />
          </IconButton>
          <IconButton
            label={`Switch to ${themeMode === "dark" ? "light" : "dark"} theme`}
            onClick={handleThemeToggle}
          >
            {themeMode === "dark" ? <SunIcon /> : <MoonIcon />}
          </IconButton>
        </div>
      </div>

      <div className="mobile-top-chrome">
        <div className="mobile-utility-bar">
          <IconButton label="Open command palette" onClick={openCommandPalette}>
            <CommandIcon />
          </IconButton>
          <IconButton label="Open shortcuts and help" onClick={openHelpDialog}>
            <HelpIcon />
          </IconButton>
          <IconButton
            label={`Switch to ${themeMode === "dark" ? "light" : "dark"} theme`}
            onClick={handleThemeToggle}
          >
            {themeMode === "dark" ? <SunIcon /> : <MoonIcon />}
          </IconButton>
        </div>

        <nav
          aria-label="Primary navigation"
          className="mobile-nav"
          onKeyDown={(event) => handleArrowKeyNavigation(event, "horizontal")}
        >
          {MOBILE_SECTIONS.map((section) => (
            <button
              aria-controls={`app-section-${section.id}`}
              aria-pressed={mobileSection === section.id}
              className={mobileSection === section.id ? "is-active" : ""}
              data-roving-focus="true"
              key={section.id}
              onClick={() => focusSection(section.id, { focusTarget: false })}
              type="button"
            >
              {section.label}
            </button>
          ))}
        </nav>
      </div>

      <aside
        className={buildPanelClassName("panel rail", "agents", mobileSection)}
        id="app-section-agents"
      >
        <div className="panel-header">
          <div>
            <p className="eyebrow">Agents</p>
            <h1>Gemma Agent</h1>
          </div>
          <button
            className="ghost-button"
            onClick={handleNewChat}
            ref={newChatButtonRef}
            type="button"
          >
            New chat
          </button>
        </div>
        <div className="agent-list" data-mobile-scroll-region="true">
          {agentsQuery.data?.map((agent) => (
            <button
              aria-pressed={agent.id === selectedAgentId}
              className={`agent-card ${agent.id === selectedAgentId ? "is-active" : ""}`}
              data-roving-focus="true"
              key={agent.id}
              onKeyDown={(event) =>
                handleSiblingArrowKeyNavigation(event, "vertical")
              }
              onClick={() => {
                setSelectedAgentId(agent.id);
                focusSection("chat", {
                  focusTarget: window.innerWidth >= DESKTOP_BREAKPOINT,
                });
              }}
              type="button"
            >
              <div className="agent-card-top">
                <strong>{agent.title}</strong>
                <span>{agent.sessionCount} chats</span>
              </div>
              <p>{agent.description}</p>
              <div className="chip-row">
                <span className="chip">{agent.id}</span>
                <span className="chip">{agent.skillNames.length} skills</span>
              </div>
            </button>
          ))}
        </div>
        <button
          aria-controls="app-section-agents"
          aria-label="Resize agents panel"
          className="panel-resizer"
          onKeyDown={(event) => handlePanelResizerKeyDown("agents", event)}
          onPointerDown={(event) => startPanelResize("agents", event)}
          type="button"
        />
      </aside>

      <aside
        className={buildPanelClassName(
          "panel sessions-panel",
          "history",
          mobileSection
        )}
        id="app-section-history"
      >
        <div className="panel-header">
          <div>
            <p className="eyebrow">
              {historyView === "active" ? "History" : "Trash"}
            </p>
            <h2>{selectedAgent?.title ?? "Select an agent"}</h2>
          </div>
          <div className="panel-header-actions">
            <fieldset
              className="mode-toggle"
              aria-label="History view"
              onKeyDown={(event) =>
                handleArrowKeyNavigation(event, "horizontal")
              }
            >
              <button
                aria-pressed={historyView === "active"}
                className={historyView === "active" ? "is-active" : ""}
                data-roving-focus="true"
                onClick={() => setHistoryView("active")}
                ref={recentHistoryButtonRef}
                type="button"
              >
                Recent
              </button>
              <button
                aria-pressed={historyView === "deleted"}
                className={historyView === "deleted" ? "is-active" : ""}
                data-roving-focus="true"
                onClick={() => setHistoryView("deleted")}
                type="button"
              >
                Trash
              </button>
            </fieldset>
            <span className={`status-chip status-${status.toLowerCase()}`}>
              {status}
            </span>
          </div>
        </div>
        {historyError ? <p className="panel-error">{historyError}</p> : null}
        <div className="session-list" data-mobile-scroll-region="true">
          {(sessionsQuery.data ?? []).map((session) => (
            <article
              className={`session-card ${session.sessionId === activeSessionId ? "is-active" : ""}`}
              key={session.sessionId}
            >
              <button
                aria-pressed={session.sessionId === activeSessionId}
                className="session-card-button"
                data-roving-focus="true"
                onKeyDown={(event) =>
                  handleSiblingArrowKeyNavigation(event, "vertical")
                }
                onClick={() => {
                  if (!selectedAgentId) {
                    return;
                  }
                  setSelectedSessionId(selectedAgentId, session.sessionId);
                  focusSection("chat", {
                    focusTarget: window.innerWidth >= DESKTOP_BREAKPOINT,
                  });
                }}
                type="button"
              >
                <div className="session-card-top">
                  <strong>{session.title}</strong>
                  {session.deletedAt ? (
                    <span className="chip chip-danger">Deleted</span>
                  ) : null}
                </div>
                <p>{session.summary}</p>
                <span className="session-card-meta">
                  {formatTime(
                    historyView === "deleted"
                      ? session.deletedAt
                      : (session.lastTurnAt ?? session.startedAt)
                  )}
                </span>
              </button>
              <div className="session-card-actions">
                {renderSessionActionButtons(session)}
              </div>
            </article>
          ))}
          {!sessionsQuery.data?.length && (
            <div className="empty-state small">
              <p>
                {historyView === "active"
                  ? "Start a new thread for this agent to create local history."
                  : "Soft-deleted chats land here until you restore them or delete them forever."}
              </p>
            </div>
          )}
        </div>
        <button
          aria-controls="app-section-history"
          aria-label="Resize history panel"
          className="panel-resizer"
          onKeyDown={(event) => handlePanelResizerKeyDown("history", event)}
          onPointerDown={(event) => startPanelResize("history", event)}
          type="button"
        />
      </aside>

      <main
        aria-busy={streaming.sending}
        className={buildPanelClassName(
          "panel chat-panel",
          "chat",
          mobileSection
        )}
        id="app-section-chat"
      >
        <header className="chat-header">
          <div>
            <p className="eyebrow">Local Gemma chat</p>
            <h2>
              {thread?.title ?? selectedAgent?.title ?? "Choose an agent"}
            </h2>
            <p className="support-text">
              {threadDeleted
                ? "Read-only · moved to Trash"
                : streaming.sending
                  ? "Streaming live"
                  : "Streaming ready"}{" "}
              · {modelTone}
            </p>
            <div className="chat-overview">
              <span className="chip">
                {selectedModel?.displayName ??
                  runtimeConfig.model ??
                  "No model"}
              </span>
              <span className="chip">{activePreset.title}</span>
              <span className="chip">
                {historyView === "active"
                  ? `${sessionsQuery.data?.length ?? 0} recent chats`
                  : `${sessionsQuery.data?.length ?? 0} in Trash`}
              </span>
            </div>
          </div>
          <div className="chat-header-controls">
            <div className="chat-header-actions">
              <fieldset
                className="mode-toggle"
                aria-label="Thinking mode"
                onKeyDown={(event) =>
                  handleArrowKeyNavigation(event, "horizontal")
                }
              >
                <button
                  aria-pressed={modeValue === "fast"}
                  className={modeValue === "fast" ? "is-active" : ""}
                  data-roving-focus="true"
                  onClick={() => handleModeChange("fast")}
                  type="button"
                >
                  Fast
                </button>
                <button
                  aria-pressed={modeValue === "think"}
                  className={modeValue === "think" ? "is-active" : ""}
                  data-roving-focus="true"
                  onClick={() => handleModeChange("think")}
                  type="button"
                >
                  Think
                </button>
              </fieldset>
              <button
                aria-controls="app-section-details"
                aria-expanded={modelDetailsOpen}
                className="ghost-button"
                onClick={() => handleModelDetailsToggle(!modelDetailsOpen)}
                ref={chatDetailsToggleRef}
                type="button"
              >
                {modelDetailsOpen ? "Hide details" : "Show details"}
              </button>
            </div>
            {thread ? (
              <div className="chat-thread-actions">
                {renderSessionActionButtons(thread)}
              </div>
            ) : null}
          </div>
        </header>

        <div
          aria-label="Conversation timeline"
          aria-live="polite"
          className="timeline"
          data-mobile-scroll-region="true"
          onPointerDownCapture={handleTimelinePointerDownCapture}
          ref={timelineRef}
          role="log"
        >
          {messages.length === 0 ? (
            <div className="empty-state">
              <h3>Local-first Gemma 4 chat</h3>
              <p>
                Use Fast for quick drafting and Think for slower, deeper Gemma
                runs. Agents and history are loaded from your min-kb-store
                checkout.
              </p>
            </div>
          ) : (
            messages.map((message) => (
              <MessageCard
                key={message.key}
                skillActivities={message.skillActivities}
                turn={message.turn}
                streaming={message.streaming}
              />
            ))
          )}
        </div>

        <footer className="composer">
          {streaming.error ? (
            <p className="error-text">{streaming.error}</p>
          ) : null}
          <textarea
            aria-describedby="composer-shortcuts"
            aria-label="Message composer"
            className="composer-input"
            disabled={threadDeleted}
            onChange={(event) => setDraft(draftKey, event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                void handleSend();
              }
            }}
            placeholder={
              threadDeleted
                ? "Restore this chat from Trash to continue it."
                : modeValue === "fast"
                  ? "Ask for a quick answer..."
                  : "Ask for planning, debugging, or multi-step reasoning..."
            }
            ref={composerInputRef}
            value={draft}
          />
          <div className="hint-list">
            <span className="chip">{activePreset.title}</span>
            <span className="chip">
              {healthQuery.data?.lmStudioReachable
                ? "LM Studio connected"
                : "History-only mode"}
            </span>
            <span className="chip" id="composer-shortcuts">
              Ctrl/Cmd+Enter sends
            </span>
          </div>
          <div className="composer-actions">
            {streaming.sending ? (
              <button
                className="secondary-button"
                onClick={handleStop}
                type="button"
              >
                Stop
              </button>
            ) : null}
            <button
              className="primary-button"
              disabled={!canSend}
              onClick={() => void handleSend()}
              type="button"
            >
              Send
            </button>
          </div>
        </footer>
      </main>

      {modelDetailsOpen ? (
        <aside
          className={buildPanelClassName(
            buildDetailPanelClassName(modelDetailsOpen),
            "details",
            mobileSection
          )}
          id="app-section-details"
        >
          <div className="panel-header">
            <div>
              <p className="eyebrow">Details</p>
              <h2>{agentDetailQuery.data?.title ?? "No agent selected"}</h2>
            </div>
            <button
              aria-controls="app-section-details"
              aria-expanded={modelDetailsOpen}
              className="ghost-button"
              onClick={() => handleModelDetailsToggle(!modelDetailsOpen)}
              ref={modelDetailsToggleRef}
              type="button"
            >
              {modelDetailsOpen ? "Hide details" : "Show details"}
            </button>
          </div>
          <div
            className="detail-panel-content"
            data-mobile-scroll-region="true"
            id="agent-details-content"
          >
            <section className="detail-section">
              <h3>Agent</h3>
              <p>
                {agentDetailQuery.data?.description ??
                  "Select an agent to inspect its prompt bundle."}
              </p>
              <div className="chip-row">
                {(agentDetailQuery.data?.skillNames ?? []).map((skillName) => (
                  <span className="chip" key={skillName}>
                    {skillName}
                  </span>
                ))}
              </div>
            </section>
            <section className="detail-section">
              <h3>Agent console</h3>
              <p>Live request and tool-call events for the latest run.</p>
              {streamConsoleEntries.length > 0 ? (
                <div
                  aria-label="Agent console"
                  aria-live="polite"
                  className="console-log"
                  role="log"
                >
                  {streamConsoleEntries.map((entry) => (
                    <article
                      className={`console-entry tone-${entry.tone}`}
                      key={entry.id}
                    >
                      <div className="console-entry-header">
                        <strong>{entry.summary}</strong>
                        <span>{formatTime(entry.timestamp)}</span>
                      </div>
                      {entry.detail ? (
                        <details className="console-entry-payload">
                          <summary>Payload</summary>
                          <pre>{entry.detail}</pre>
                        </details>
                      ) : null}
                    </article>
                  ))}
                </div>
              ) : (
                <p className="support-text detail-hint">
                  Send a message to populate the console with request and
                  tool-call logs.
                </p>
              )}
            </section>
            <section className="detail-section">
              <h3>Model</h3>
              <p>
                {selectedModel?.displayName ??
                  runtimeConfig.model ??
                  "Choose a model for this chat."}
              </p>
              <div className="chip-row">
                <span className="chip">{activePreset.title}</span>
                {selectedModel ? (
                  <span className="chip">{selectedModel.provider}</span>
                ) : null}
                <span className="chip">{modelTone}</span>
              </div>
            </section>
            <section className="detail-section">
              <h3>Scheduled tasks</h3>
              <p>
                Run saved prompts every hour, every day, or every week. The API
                keeps the cadence steady, and the app checks in gently while
                backgrounded to avoid wasting battery.
              </p>
              <div className="chip-row">
                <span className="chip">
                  {selectedAgentSchedules.length} schedule
                  {selectedAgentSchedules.length === 1 ? "" : "s"}
                </span>
                <span className="chip">{isOnline ? "Online" : "Offline"}</span>
                <span className="chip">
                  Polling{" "}
                  {getSchedulePollingInterval({
                    documentHidden: isDocumentHidden,
                    isOnline,
                    notificationsEnabled,
                  }) === false
                    ? "paused"
                    : isDocumentHidden
                      ? "5 min"
                      : "1 min"}
                </span>
              </div>
              <div className="detail-actions">
                <button
                  className="secondary-button"
                  disabled={!selectedAgentId}
                  onClick={() => openScheduleEditor()}
                  type="button"
                >
                  New schedule
                </button>
              </div>
              {scheduleError ? (
                <p className="error-text detail-hint">{scheduleError}</p>
              ) : null}
              {scheduleEditorOpen ? (
                <div className="schedule-editor">
                  <label className="control-stack">
                    <span className="control-label">Title</span>
                    <input
                      className="text-input"
                      onChange={(event) =>
                        updateScheduleDraft("title", event.target.value)
                      }
                      placeholder="Daily summary"
                      value={scheduleDraft.title}
                    />
                  </label>
                  <label className="control-stack">
                    <span className="control-label">Prompt</span>
                    <textarea
                      className="composer-input schedule-editor-input"
                      onChange={(event) =>
                        updateScheduleDraft("prompt", event.target.value)
                      }
                      placeholder="Summarize the latest activity."
                      value={scheduleDraft.prompt}
                    />
                  </label>
                  <div className="detail-controls">
                    <label className="control-stack">
                      <span className="control-label">Recurrence</span>
                      <select
                        className="select"
                        onChange={(event) =>
                          updateScheduleDraft(
                            "recurrence",
                            event.target
                              .value as ScheduleDraftState["recurrence"]
                          )
                        }
                        value={scheduleDraft.recurrence}
                      >
                        <option value="hourly">Hourly</option>
                        <option value="daily">Daily</option>
                        <option value="weekly">Weekly</option>
                      </select>
                    </label>
                    <label className="control-stack">
                      <span className="control-label">Minute</span>
                      <input
                        className="text-input"
                        inputMode="numeric"
                        max="59"
                        min="0"
                        onChange={(event) =>
                          updateScheduleDraft(
                            "minuteOfHour",
                            event.target.value
                          )
                        }
                        type="number"
                        value={scheduleDraft.minuteOfHour}
                      />
                    </label>
                    {scheduleDraft.recurrence !== "hourly" ? (
                      <label className="control-stack">
                        <span className="control-label">Hour</span>
                        <input
                          className="text-input"
                          inputMode="numeric"
                          max="23"
                          min="0"
                          onChange={(event) =>
                            updateScheduleDraft("hourOfDay", event.target.value)
                          }
                          type="number"
                          value={scheduleDraft.hourOfDay}
                        />
                      </label>
                    ) : null}
                    {scheduleDraft.recurrence === "weekly" ? (
                      <label className="control-stack">
                        <span className="control-label">Day</span>
                        <select
                          className="select"
                          onChange={(event) =>
                            updateScheduleDraft("dayOfWeek", event.target.value)
                          }
                          value={scheduleDraft.dayOfWeek}
                        >
                          {WEEKDAY_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : null}
                  </div>
                  <div className="detail-controls">
                    <label className="control-stack">
                      <span className="control-label">Session history</span>
                      <select
                        className="select"
                        onChange={(event) =>
                          updateScheduleDraft(
                            "sessionMode",
                            event.target
                              .value as ScheduleDraftState["sessionMode"]
                          )
                        }
                        value={scheduleDraft.sessionMode}
                      >
                        <option value="dedicated">Reuse one thread</option>
                        <option value="fresh">
                          Create a new thread each run
                        </option>
                      </select>
                    </label>
                    <label className="control-stack">
                      <span className="control-label">Time zone</span>
                      <input
                        className="text-input"
                        onChange={(event) =>
                          updateScheduleDraft("timezone", event.target.value)
                        }
                        value={scheduleDraft.timezone}
                      />
                    </label>
                  </div>
                  <div className="detail-controls schedule-toggle-grid">
                    <label className="checkbox-row">
                      <input
                        checked={scheduleDraft.enabled}
                        onChange={(event) =>
                          updateScheduleDraft("enabled", event.target.checked)
                        }
                        type="checkbox"
                      />
                      <span>Enabled</span>
                    </label>
                    <label className="checkbox-row">
                      <input
                        checked={scheduleDraft.notifyOnCompletion}
                        onChange={(event) =>
                          updateScheduleDraft(
                            "notifyOnCompletion",
                            event.target.checked
                          )
                        }
                        type="checkbox"
                      />
                      <span>Notify on completion</span>
                    </label>
                  </div>
                  <div className="detail-actions">
                    <button
                      className="primary-button"
                      disabled={scheduleSubmitting || !selectedAgentId}
                      onClick={() => void handleScheduleSubmit()}
                      type="button"
                    >
                      {editingScheduleId ? "Save schedule" : "Create schedule"}
                    </button>
                    <button
                      className="ghost-button"
                      onClick={closeScheduleEditor}
                      type="button"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : null}
              <div className="schedule-list">
                {selectedAgentSchedules.map((task) => (
                  <article className="schedule-card" key={task.id}>
                    <div className="schedule-card-top">
                      <strong>{task.title}</strong>
                      <span
                        className={`chip ${task.enabled ? "" : "chip-danger"}`}
                      >
                        {task.enabled ? "Enabled" : "Paused"}
                      </span>
                    </div>
                    <p>{describeScheduledTask(task)}</p>
                    <div className="chip-row">
                      <span className="chip">{task.timezone}</span>
                      <span className="chip">
                        Next {formatTime(task.nextRunAt)}
                      </span>
                      <span className="chip">
                        Last {task.lastRunStatus ?? "idle"}
                      </span>
                    </div>
                    {task.lastRunError ? (
                      <p className="error-text detail-hint">
                        {task.lastRunError}
                      </p>
                    ) : task.lastAssistantSummary ? (
                      <p className="support-text detail-hint">
                        {task.lastAssistantSummary}
                      </p>
                    ) : null}
                    <div className="detail-actions">
                      <button
                        className="secondary-button"
                        onClick={() => void handleScheduledTaskRun(task)}
                        type="button"
                      >
                        Run now
                      </button>
                      <button
                        className="ghost-button"
                        onClick={() => openScheduleEditor(task)}
                        type="button"
                      >
                        Edit
                      </button>
                      <button
                        className="ghost-button"
                        onClick={() => void handleScheduledTaskToggle(task)}
                        type="button"
                      >
                        {task.enabled ? "Pause" : "Resume"}
                      </button>
                      <button
                        className="ghost-button danger-button"
                        onClick={() => void handleScheduledTaskDelete(task)}
                        type="button"
                      >
                        Delete
                      </button>
                    </div>
                  </article>
                ))}
                {selectedAgentSchedules.length === 0 ? (
                  <p className="support-text detail-hint">
                    No schedules yet. Create one to automate recurring prompts
                    for this agent.
                  </p>
                ) : null}
              </div>
            </section>
            <section className="detail-section">
              <h3>Notifications</h3>
              <p>
                Get a browser notification when a reply finishes while the app
                is in the background.
              </p>
              <div className="chip-row">
                <span className="chip">
                  {notificationsEnabled ? "Enabled" : "Disabled"}
                </span>
                <span className="chip">
                  Permission:{" "}
                  {formatNotificationPermissionLabel(notificationPermission)}
                </span>
              </div>
              <div className="detail-actions">
                <button
                  className="secondary-button"
                  onClick={() => void handleNotificationsToggle()}
                  type="button"
                >
                  {notificationsEnabled
                    ? "Disable notifications"
                    : "Enable notifications"}
                </button>
              </div>
              {notificationError ? (
                <p className="error-text detail-hint">{notificationError}</p>
              ) : (
                <p className="support-text detail-hint">
                  Notifications stay local to this device and only fire after a
                  completed reply.
                </p>
              )}
            </section>
            <section className="detail-section" id="model-details-panel">
              <h3>Model details</h3>
              <div className="detail-controls">
                <label className="control-stack">
                  <span className="control-label">Model</span>
                  <select
                    aria-label="Chat model"
                    className="select"
                    onChange={(event) =>
                      updateRuntimeConfigState((current) => ({
                        ...current,
                        model: event.target.value,
                      }))
                    }
                    value={runtimeConfig.model ?? ""}
                  >
                    {(modelsQuery.data ?? []).map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.displayName}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="control-stack">
                  <span className="control-label">Preset</span>
                  <select
                    aria-label="Gemma preset"
                    className="select"
                    onChange={(event) =>
                      updateRuntimeConfigState((current) =>
                        applyPresetRuntimeConfig(current, event.target.value)
                      )
                    }
                    ref={presetSelectRef}
                    value={runtimeConfig.presetId ?? GEMMA_BALANCED_PRESET_ID}
                  >
                    {GEMMA_PRESETS.map((preset) => (
                      <option key={preset.id} value={preset.id}>
                        {preset.title}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <p>{activePreset.description}</p>
              <p className="support-text">
                The Fast/Think toggle changes reasoning mode only and keeps the
                current preset budget.
              </p>
              <dl className="stats-grid">
                <div>
                  <dt>Provider</dt>
                  <dd>{selectedModel?.provider ?? "—"}</dd>
                </div>
                <div>
                  <dt>Thinking</dt>
                  <dd>{thinkingEnabled ? "On" : "Off"}</dd>
                </div>
                <div>
                  <dt>Max tokens</dt>
                  <dd>
                    {runtimeConfig.maxCompletionTokens ??
                      activePreset.maxCompletionTokens}
                  </dd>
                </div>
                <div>
                  <dt>Context window</dt>
                  <dd>
                    {runtimeConfig.contextWindowSize ??
                      activePreset.contextWindowSize}
                  </dd>
                </div>
                <div>
                  <dt>Temperature</dt>
                  <dd>
                    {runtimeConfig.temperature ?? activePreset.temperature}
                  </dd>
                </div>
                <div>
                  <dt>Top P</dt>
                  <dd>{runtimeConfig.topP ?? activePreset.topP}</dd>
                </div>
              </dl>
            </section>
            <section className="detail-section">
              <h3>Local status</h3>
              <p>{healthQuery.data?.message ?? "Checking LM Studio..."}</p>
              <dl className="stats-grid">
                <div>
                  <dt>Store root</dt>
                  <dd>{healthQuery.data?.workspace.storeRoot ?? "—"}</dd>
                </div>
                <div>
                  <dt>Agents</dt>
                  <dd>{healthQuery.data?.workspace.agentCount ?? 0}</dd>
                </div>
                <div>
                  <dt>Models</dt>
                  <dd>{healthQuery.data?.modelCount ?? 0}</dd>
                </div>
                <div>
                  <dt>Default</dt>
                  <dd>{healthQuery.data?.defaultModel ?? "—"}</dd>
                </div>
              </dl>
            </section>
          </div>
        </aside>
      ) : null}
      {isHelpOpen ? (
        <div className="dialog-overlay">
          <section
            aria-labelledby="help-dialog-title"
            aria-modal="true"
            className="help-dialog"
            onMouseDown={(event) => event.stopPropagation()}
            role="dialog"
          >
            <div className="help-dialog-header">
              <div>
                <p className="eyebrow">Help</p>
                <h2 id="help-dialog-title">Shortcuts and quick tips</h2>
              </div>
              <button
                className="ghost-button"
                onClick={() => closeHelpDialog()}
                ref={helpCloseButtonRef}
                type="button"
              >
                Close <kbd>Esc</kbd>
              </button>
            </div>
            <div className="help-dialog-content">
              <section className="help-dialog-section">
                <h3>Keyboard shortcuts</h3>
                <dl className="shortcut-list">
                  <div>
                    <dt>
                      <kbd>Ctrl/Cmd+K</kbd>
                    </dt>
                    <dd>Open quick actions.</dd>
                  </div>
                  <div>
                    <dt>
                      <kbd>/</kbd>
                    </dt>
                    <dd>Jump to the composer.</dd>
                  </div>
                  <div>
                    <dt>
                      <kbd>Alt+1-4</kbd>
                    </dt>
                    <dd>Move between chat, agents, history, and details.</dd>
                  </div>
                  <div>
                    <dt>
                      <kbd>N</kbd>
                    </dt>
                    <dd>Start a new chat for the selected agent.</dd>
                  </div>
                  <div>
                    <dt>
                      <kbd>?</kbd>
                    </dt>
                    <dd>Open this help sheet.</dd>
                  </div>
                </dl>
              </section>
              <section className="help-dialog-section">
                <h3>Quick tips</h3>
                <ul className="help-list">
                  <li>
                    Drag the handles beside Agents and History on desktop.
                  </li>
                  <li>
                    Fast and Think only change reasoning mode; the preset stays
                    in place.
                  </li>
                  <li>
                    Details holds model settings and the live tool-call console.
                  </li>
                  <li>
                    Move chats to Trash first, then restore or delete them
                    forever later.
                  </li>
                </ul>
              </section>
            </div>
          </section>
        </div>
      ) : null}
      {isCommandPaletteOpen ? (
        <div className="command-palette-overlay">
          <section
            aria-labelledby="command-palette-title"
            aria-modal="true"
            className="command-palette"
            onMouseDown={(event) => event.stopPropagation()}
            role="dialog"
          >
            <div className="command-palette-header">
              <div>
                <p className="eyebrow">Command palette</p>
                <h2 id="command-palette-title">Quick actions</h2>
              </div>
              <button
                className="ghost-button"
                onClick={() => closeCommandPalette()}
                type="button"
              >
                Close <kbd>Esc</kbd>
              </button>
            </div>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const firstCommand = visibleCommandItems[0];
                if (!firstCommand) {
                  return;
                }
                handleCommandSelection(firstCommand);
              }}
            >
              <input
                aria-label="Search commands"
                aria-activedescendant={
                  selectedCommand
                    ? `command-item-${selectedCommand.id}`
                    : undefined
                }
                className="command-palette-search"
                onChange={(event) => setCommandQuery(event.target.value)}
                onKeyDown={handleCommandPaletteKeyDown}
                placeholder="Type a command or jump to a panel..."
                ref={commandPaletteInputRef}
                value={commandQuery}
              />
            </form>
            <div className="command-palette-list">
              {groupedCommandItems.length > 0 ? (
                groupedCommandItems.map(([group, commands]) => (
                  <div className="command-palette-group" key={group}>
                    <p className="command-palette-group-label">{group}</p>
                    {commands.map((command) => (
                      <button
                        className={`command-item ${
                          selectedCommand?.id === command.id
                            ? "is-selected"
                            : ""
                        }`}
                        id={`command-item-${command.id}`}
                        key={command.id}
                        onMouseEnter={() =>
                          setCommandSelectionIndex(
                            visibleCommandItems.findIndex(
                              (visibleCommand) =>
                                visibleCommand.id === command.id
                            )
                          )
                        }
                        onClick={() => handleCommandSelection(command)}
                        type="button"
                      >
                        <span className="command-item-copy">
                          <strong>{command.label}</strong>
                          <span>{command.description}</span>
                        </span>
                        {command.shortcut ? (
                          <kbd>{command.shortcut}</kbd>
                        ) : null}
                      </button>
                    ))}
                  </div>
                ))
              ) : (
                <p className="command-item-empty">
                  No commands match that search.
                </p>
              )}
            </div>
            <div className="command-palette-footer">
              <span>
                {visibleCommandItems.length} command
                {visibleCommandItems.length === 1 ? "" : "s"}
              </span>
              <span>
                <kbd>↑</kbd>/<kbd>↓</kbd> navigate · <kbd>Enter</kbd> run
              </span>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}

function MessageCard(props: {
  skillActivities?: StreamSkillActivity[];
  turn: ChatTurn;
  streaming?: boolean;
}) {
  const hasBody = props.turn.bodyMarkdown.trim().length > 0;
  const label =
    props.turn.sender === "user"
      ? "You"
      : props.turn.sender === "tool"
        ? "Skill"
        : "Assistant";

  return (
    <article
      className={`message-card ${
        props.turn.sender === "user"
          ? "user"
          : props.turn.sender === "tool"
            ? "tool"
            : "assistant"
      }`}
    >
      <div className="message-header">
        <strong>{label}</strong>
        <span>
          {props.streaming ? "Streaming..." : formatTime(props.turn.createdAt)}
        </span>
      </div>
      {hasBody ? (
        <div
          className={`message-body ${props.streaming ? "is-streaming" : ""}`}
        >
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {props.turn.bodyMarkdown}
          </ReactMarkdown>
        </div>
      ) : null}
      {props.skillActivities?.length ? (
        <div className="skill-activity-list">
          {props.skillActivities.map((activity) => (
            <details className="skill-activity-details" key={activity.id}>
              <summary>
                <span>{`Skill call · ${activity.skillName}`}</span>
                <span>
                  {activity.exitCode === undefined
                    ? "Running"
                    : `Exit ${activity.exitCode}`}
                </span>
              </summary>
              {activity.skillInput ? (
                <div className="skill-activity-block">
                  <strong>Input</strong>
                  <pre>{activity.skillInput}</pre>
                </div>
              ) : null}
              {activity.skillOutput !== undefined ? (
                <div className="skill-activity-block">
                  <strong>Result</strong>
                  <pre>{activity.skillOutput}</pre>
                </div>
              ) : null}
            </details>
          ))}
        </div>
      ) : null}
      {props.turn.thinkingMarkdown ? (
        <details className="thinking-details">
          <summary>Reasoning trace</summary>
          <pre>{props.turn.thinkingMarkdown}</pre>
        </details>
      ) : null}
    </article>
  );
}

function resolveSkillActivities(
  activities: StreamSkillActivity[],
  event: Extract<ChatStreamEvent, { type: "skill_result" }>
): StreamSkillActivity[] {
  const matchIndex = event.skillCallId
    ? activities.findIndex((activity) => activity.id === event.skillCallId)
    : findLatestPendingSkillActivityIndex(activities, event.skillName);

  if (matchIndex < 0) {
    return [
      ...activities,
      {
        exitCode: event.exitCode,
        id: event.skillCallId ?? `${event.skillName}-${Date.now()}-result`,
        skillInput: "",
        skillName: event.skillName,
        skillOutput: event.skillOutput,
      },
    ];
  }

  return activities.map((activity, index) =>
    index === matchIndex
      ? {
          ...activity,
          exitCode: event.exitCode,
          skillOutput: event.skillOutput,
        }
      : activity
  );
}

function findLatestPendingSkillActivityIndex(
  activities: StreamSkillActivity[],
  skillName: string
): number {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (activity?.skillName === skillName && activity.exitCode === undefined) {
      return index;
    }
  }

  return -1;
}

function createScheduleDraftState(task?: ScheduledTask): ScheduleDraftState {
  const timezone =
    task?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
  return {
    title: task?.title ?? "",
    prompt: task?.prompt ?? "",
    recurrence: task?.recurrence ?? "daily",
    minuteOfHour: String(task?.minuteOfHour ?? 0),
    hourOfDay: String(task?.hourOfDay ?? 9),
    dayOfWeek: String(task?.dayOfWeek ?? 1),
    sessionMode: task?.sessionMode ?? "dedicated",
    notifyOnCompletion: task?.notifyOnCompletion ?? true,
    enabled: task?.enabled ?? true,
    timezone,
  };
}

function buildScheduledTaskPayload(
  agentId: string,
  draft: ScheduleDraftState
): ScheduledTaskCreate {
  const minuteOfHour = Number(draft.minuteOfHour);
  const hourOfDay = Number(draft.hourOfDay);
  const dayOfWeek = Number(draft.dayOfWeek);
  return {
    agentId,
    title: draft.title.trim(),
    prompt: draft.prompt.trim(),
    recurrence: draft.recurrence,
    minuteOfHour,
    ...(draft.recurrence !== "hourly" ? { hourOfDay } : {}),
    ...(draft.recurrence === "weekly" ? { dayOfWeek } : {}),
    timezone: draft.timezone.trim() || "UTC",
    enabled: draft.enabled,
    notifyOnCompletion: draft.notifyOnCompletion,
    sessionMode: draft.sessionMode,
  };
}

function IconButton(props: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      aria-label={props.label}
      className="icon-button"
      onClick={props.onClick}
      type="button"
    >
      {props.children}
    </button>
  );
}

function CommandIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path
        d="M4 7.5a3.5 3.5 0 0 1 7 0V10h2V7.5a3.5 3.5 0 1 1 3.5 3.5H14v2h2.5a3.5 3.5 0 1 1-3.5 3.5V14h-2v2.5a3.5 3.5 0 1 1-3.5-3.5H10v-2H7.5A3.5 3.5 0 0 1 4 7.5Zm3.5-1.5a1.5 1.5 0 1 0 0 3H10V7.5A1.5 1.5 0 0 0 7.5 6Zm9 0A1.5 1.5 0 0 0 15 7.5V9h1.5a1.5 1.5 0 1 0 0-3Zm0 9H15v1.5a1.5 1.5 0 1 0 1.5-1.5Zm-9 0a1.5 1.5 0 1 0 1.5 1.5V15H7.5Z"
        fill="currentColor"
      />
    </svg>
  );
}

function HelpIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path
        d="M12 3.5a8.5 8.5 0 1 1 0 17a8.5 8.5 0 0 1 0-17Zm0 2a6.5 6.5 0 1 0 0 13a6.5 6.5 0 0 0 0-13Zm0 9.75a1.12 1.12 0 1 1 0 2.25a1.12 1.12 0 0 1 0-2.25Zm.1-7a3.3 3.3 0 0 1 2.28.77c.6.5.95 1.23.95 2.09c0 .7-.21 1.27-.62 1.75c-.3.34-.63.6-.95.82c-.51.35-.76.58-.86.74c-.1.14-.15.34-.15.68v.3h-2v-.42c0-.68.12-1.23.4-1.66c.28-.42.69-.77 1.22-1.12c.28-.2.5-.37.65-.54c.2-.24.31-.49.31-.87c0-.3-.11-.55-.35-.75c-.25-.2-.56-.3-.93-.3c-.44 0-.79.12-1.02.35c-.25.23-.4.56-.45 1.02H8.58c.05-.98.4-1.77 1.02-2.35c.62-.57 1.45-.86 2.5-.86Z"
        fill="currentColor"
      />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path
        d="M14.9 4.1a7.83 7.83 0 0 0 4.99 12.47a.75.75 0 0 1 .42 1.34a9.67 9.67 0 1 1-5.4-16.48a.75.75 0 0 1 0 1.5Zm-2.35.96a8.17 8.17 0 1 0 5.86 11.26a9.34 9.34 0 0 1-5.86-11.26Z"
        fill="currentColor"
      />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path
        d="M12 5.25A.75.75 0 0 1 12.75 6v1.25a.75.75 0 0 1-1.5 0V6a.75.75 0 0 1 .75-.75Zm0 11.5a.75.75 0 0 1 .75.75v1.25a.75.75 0 0 1-1.5 0V17.5a.75.75 0 0 1 .75-.75Zm6-4.75a.75.75 0 0 1 .75-.75H20a.75.75 0 0 1 0 1.5h-1.25A.75.75 0 0 1 18 12Zm-14 0a.75.75 0 0 1 .75-.75H6a.75.75 0 0 1 0 1.5H4.75A.75.75 0 0 1 4 12Zm10.3-4.05a.75.75 0 0 1 1.06 0l.88.88a.75.75 0 0 1-1.06 1.06l-.88-.88a.75.75 0 0 1 0-1.06Zm-6.72 6.72a.75.75 0 0 1 1.06 0l.88.88a.75.75 0 0 1-1.06 1.06l-.88-.88a.75.75 0 0 1 0-1.06Zm7.78 1.94a.75.75 0 0 1 0-1.06l.88-.88a.75.75 0 1 1 1.06 1.06l-.88.88a.75.75 0 0 1-1.06 0Zm-6.72-6.72a.75.75 0 0 1 0-1.06l.88-.88a.75.75 0 1 1 1.06 1.06l-.88.88a.75.75 0 0 1-1.06 0ZM12 8.25a3.75 3.75 0 1 1 0 7.5a3.75 3.75 0 0 1 0-7.5Zm0 1.5a2.25 2.25 0 1 0 0 4.5a2.25 2.25 0 0 0 0-4.5Z"
        fill="currentColor"
      />
    </svg>
  );
}

function buildPanelClassName(
  baseClassName: string,
  section: MobileSection,
  activeSection: MobileSection
): string {
  return `${baseClassName} ${
    activeSection === section ? "mobile-panel-active" : "mobile-panel-hidden"
  }`;
}

function confirmSessionAction(
  session: ChatSessionSummary,
  action: SessionAction
): boolean {
  if (action === "restore") {
    return window.confirm(`Restore "${session.title}" to active history?`);
  }
  if (action === "permanent-delete") {
    return window.confirm(
      `Permanently delete "${session.title}"? This removes the session files from disk and cannot be undone.`
    );
  }
  return window.confirm(
    `Move "${session.title}" to Trash? You can restore it later or delete it forever from the Trash view.`
  );
}
