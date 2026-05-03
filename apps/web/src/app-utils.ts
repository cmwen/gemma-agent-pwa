import {
  type ChatSession,
  type ChatStreamEvent,
  type ChatTurn,
  getPresetById,
  type PartialChatRuntimeConfig,
  type ScheduledTask,
} from "@gemma-agent-pwa/contracts";

interface StreamingStateSnapshot {
  sending: boolean;
  assistantText?: string;
  thinkingText?: string;
  skillActivities?: StreamSkillActivity[];
}

export interface CommandSearchableItem {
  label: string;
  description: string;
  keywords: string[];
}

export interface StreamConsoleEntry {
  id: string;
  detail?: string;
  summary: string;
  timestamp: string;
  tone: "info" | "success" | "error";
}

interface ScrollPositionMetrics {
  clientHeight: number;
  scrollHeight: number;
  scrollTop: number;
  threshold?: number;
}

export interface StreamSkillActivity {
  exitCode?: number;
  id: string;
  skillInput: string;
  skillName: string;
  skillOutput?: string;
}

export type ThemeMode = "light" | "dark";
export type FocusNavigationOrientation = "horizontal" | "vertical";
export type NotificationPermissionStatus =
  | NotificationPermission
  | "unsupported";

interface CompletionNotificationInput {
  agentTitle?: string;
  assistantMarkdown?: string;
  sessionId: string;
  sessionTitle?: string;
}

interface CompletionNotificationContent {
  body: string;
  tag: string;
  title: string;
}

interface ScheduledTaskNotificationInput {
  agentTitle?: string;
  task: ScheduledTask;
}

export function buildMessages(
  thread: ChatSession | undefined,
  streaming: StreamingStateSnapshot
): Array<{
  key: string;
  skillActivities?: StreamSkillActivity[];
  streaming?: boolean;
  turn: ChatTurn;
}> {
  const turns = (thread?.turns ?? []).map((turn) => ({
    key: turn.messageId,
    turn,
  }));
  if (
    !streaming.assistantText &&
    !streaming.thinkingText &&
    !streaming.skillActivities?.length
  ) {
    return turns;
  }
  return [
    ...turns,
    {
      key: "streaming-assistant",
      skillActivities: streaming.skillActivities,
      ...(streaming.sending ? { streaming: true } : {}),
      turn: {
        messageId: "streaming-assistant",
        sender: "assistant",
        createdAt: new Date().toISOString(),
        bodyMarkdown: streaming.assistantText ?? "",
        relativePath: "",
        ...(streaming.thinkingText
          ? { thinkingMarkdown: streaming.thinkingText }
          : {}),
      },
    },
  ];
}

export function buildAppShellClassName(modelDetailsOpen: boolean): string {
  return `app-shell ${
    modelDetailsOpen ? "app-shell-details-open" : "app-shell-details-closed"
  }`;
}

export function buildDetailPanelClassName(modelDetailsOpen: boolean): string {
  return `panel detail-panel ${
    modelDetailsOpen ? "detail-panel-visible" : "detail-panel-desktop-collapsed"
  }`;
}

export function formatTime(timestamp?: string): string {
  if (!timestamp) {
    return "—";
  }
  return new Date(timestamp).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function applyPresetRuntimeConfig(
  current: PartialChatRuntimeConfig,
  presetId: string
): PartialChatRuntimeConfig {
  const preset = getPresetById(presetId);
  return {
    ...current,
    presetId: preset.id,
    lmStudioEnableThinking: preset.lmStudioEnableThinking,
    maxCompletionTokens: preset.maxCompletionTokens,
    contextWindowSize: preset.contextWindowSize,
    temperature: preset.temperature,
    topP: preset.topP,
  };
}

export function getPreferredTheme(): ThemeMode {
  if (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: light)").matches
  ) {
    return "light";
  }
  return "dark";
}

export function getNextTheme(current: ThemeMode): ThemeMode {
  return current === "dark" ? "light" : "dark";
}

export function isNotificationSupported(): boolean {
  return typeof Notification !== "undefined";
}

export function getNotificationPermission(): NotificationPermissionStatus {
  return isNotificationSupported() ? Notification.permission : "unsupported";
}

export function formatNotificationPermissionLabel(
  permission: NotificationPermissionStatus
): string {
  switch (permission) {
    case "granted":
      return "Allowed";
    case "denied":
      return "Blocked";
    case "default":
      return "Ask";
    case "unsupported":
      return "Unsupported";
  }
}

export function shouldSendCompletionNotification(options: {
  documentHidden: boolean;
  notificationsEnabled: boolean;
  permission: NotificationPermissionStatus;
  windowHasFocus: boolean;
}): boolean {
  return (
    options.notificationsEnabled &&
    options.permission === "granted" &&
    (options.documentHidden || !options.windowHasFocus)
  );
}

export function buildCompletionNotification({
  agentTitle,
  assistantMarkdown,
  sessionId,
  sessionTitle,
}: CompletionNotificationInput): CompletionNotificationContent {
  const trimmedTitle =
    sessionTitle?.trim() || agentTitle?.trim() || "Gemma Agent";
  return {
    title: `${trimmedTitle} ready`,
    body: summarizeNotificationBody(assistantMarkdown),
    tag: `gemma-agent-pwa-session-${sessionId}`,
  };
}

export function buildScheduledTaskNotification({
  agentTitle,
  task,
}: ScheduledTaskNotificationInput): CompletionNotificationContent {
  const latestRun = task.recentRuns[0];
  const title = `${task.title} finished`;
  const body = latestRun?.assistantSummary
    ? summarizeNotificationBody(latestRun.assistantSummary)
    : `Scheduled run completed for ${agentTitle?.trim() || task.agentId}.`;
  return {
    title,
    body,
    tag: `gemma-agent-pwa-schedule-${task.id}`,
  };
}

export function describeScheduledTask(
  task: Pick<
    ScheduledTask,
    "dayOfWeek" | "hourOfDay" | "minuteOfHour" | "recurrence"
  >
): string {
  const minute = task.minuteOfHour.toString().padStart(2, "0");
  switch (task.recurrence) {
    case "hourly":
      return `Every hour at :${minute}`;
    case "daily":
      return `Every day at ${String(task.hourOfDay ?? 0).padStart(2, "0")}:${minute}`;
    case "weekly":
      return `Every ${WEEKDAY_LABELS[task.dayOfWeek ?? 0]} at ${String(
        task.hourOfDay ?? 0
      ).padStart(2, "0")}:${minute}`;
  }
}

export function getSchedulePollingInterval(options: {
  documentHidden: boolean;
  isOnline: boolean;
  notificationsEnabled: boolean;
}): false | number {
  if (!options.isOnline) {
    return false;
  }
  if (!options.documentHidden) {
    return 60_000;
  }
  return options.notificationsEnabled ? 300_000 : false;
}

export function getNewScheduledTaskNotifications(
  tasks: ScheduledTask[],
  seenRunIds: Record<string, string>
): ScheduledTask[] {
  return tasks.filter((task) => {
    if (!task.notifyOnCompletion) {
      return false;
    }
    const latestRun = task.recentRuns[0];
    return (
      latestRun?.status === "success" &&
      Boolean(latestRun.completedAt) &&
      seenRunIds[task.id] !== latestRun.runId
    );
  });
}

export function filterCommandItems<T extends CommandSearchableItem>(
  commands: T[],
  query: string
): T[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return commands;
  }
  return commands.filter((command) =>
    [command.label, command.description, ...command.keywords]
      .join(" ")
      .toLowerCase()
      .includes(normalizedQuery)
  );
}

export function getNextFocusableIndex(
  currentIndex: number,
  totalItems: number,
  key: string,
  orientation: FocusNavigationOrientation
): number | undefined {
  if (totalItems < 1) {
    return undefined;
  }

  if (key === "Home") {
    return 0;
  }
  if (key === "End") {
    return totalItems - 1;
  }

  const previousKey = orientation === "horizontal" ? "ArrowLeft" : "ArrowUp";
  const nextKey = orientation === "horizontal" ? "ArrowRight" : "ArrowDown";

  if (key === previousKey) {
    return currentIndex <= 0 ? totalItems - 1 : currentIndex - 1;
  }
  if (key === nextKey) {
    return currentIndex < 0 || currentIndex === totalItems - 1
      ? 0
      : currentIndex + 1;
  }

  return undefined;
}

export function buildStreamConsoleEntry(
  event: ChatStreamEvent,
  timestamp = new Date().toISOString()
): StreamConsoleEntry | undefined {
  switch (event.type) {
    case "thread":
      return {
        id: `${timestamp}-thread`,
        summary: "Request queued",
        detail: event.thread.title,
        timestamp,
        tone: "info",
      };
    case "assistant_snapshot":
      return undefined;
    case "skill_call":
      return {
        id: `${timestamp}-skill-call-${event.skillCallId ?? event.skillName}`,
        summary: `Skill call · ${event.skillName}`,
        detail: event.skillInput,
        timestamp,
        tone: "info",
      };
    case "skill_result":
      return {
        id: `${timestamp}-skill-result-${event.skillCallId ?? event.skillName}`,
        summary: `Skill result · ${event.skillName} (exit ${event.exitCode})`,
        detail: event.skillOutput,
        timestamp,
        tone: event.exitCode === 0 ? "success" : "error",
      };
    case "complete":
      return {
        id: `${timestamp}-complete`,
        summary: "Response saved",
        detail: event.response.assistantTurn.bodyMarkdown,
        timestamp,
        tone: "success",
      };
    case "error":
      return {
        id: `${timestamp}-error`,
        summary: "Stream error",
        detail: event.error,
        timestamp,
        tone: "error",
      };
  }
}

export function isScrolledNearBottom({
  clientHeight,
  scrollHeight,
  scrollTop,
  threshold = 48,
}: ScrollPositionMetrics): boolean {
  return scrollHeight - clientHeight - scrollTop <= threshold;
}

export function isEditableElement(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement)
  );
}

function isWithinMobileScrollRegion(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }

  let current: Element | null = target;
  while (current) {
    if (
      current instanceof HTMLElement &&
      current.dataset.mobileScrollRegion === "true"
    ) {
      return true;
    }
    current = current.parentElement;
  }

  return false;
}

export function shouldBlurActiveEditableElementOnPointerDown(options: {
  activeElement: Element | null;
  desktopBreakpoint: number;
  pointerType: string;
  target: EventTarget | null;
  viewportWidth: number;
}): boolean {
  if (
    options.pointerType !== "touch" ||
    options.viewportWidth >= options.desktopBreakpoint ||
    !isEditableElement(options.activeElement)
  ) {
    return false;
  }

  if (
    !(options.activeElement instanceof Element) ||
    !(options.target instanceof Node) ||
    options.activeElement.contains(options.target)
  ) {
    return false;
  }

  if (isWithinMobileScrollRegion(options.target)) {
    return false;
  }

  return !isEditableElement(options.target);
}

function summarizeNotificationBody(markdown?: string): string {
  const plainText = (markdown ?? "")
    .replace(/```[\s\S]*?```/g, " code block ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*]\([^)]+\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[#>*_~-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!plainText) {
    return "Your latest reply is ready.";
  }

  return plainText.length <= 140
    ? plainText
    : `${plainText.slice(0, 137).trimEnd()}...`;
}

const WEEKDAY_LABELS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;
