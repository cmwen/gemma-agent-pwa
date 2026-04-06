import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  AttachmentUpload,
  ChatRuntimeConfig,
  ChatSession,
  ChatSessionSummary,
  ChatTurn,
  LlmRequestStats,
  LlmSessionStats,
  StoredAttachment,
  TurnSender,
} from "@gemma-agent-pwa/contracts";
import {
  attachmentUploadSchema,
  chatRuntimeConfigSchema,
  llmRequestStatsSchema,
  llmSessionStatsSchema,
  senderSchema,
  storedAttachmentSchema,
} from "@gemma-agent-pwa/contracts";
import {
  compactTimestamp,
  displayTimestamp,
  ensureTrailingNewline,
  isoFromCompactTimestamp,
  normalizeAgentId,
  readOptionalFile,
  slugify,
  toPosixRelative,
  walkFiles,
} from "./utils.js";
import type { MinKbWorkspace } from "./workspace.js";

const SESSION_HEADER = "# Chat Session: ";
const SUMMARY_MARKER = "\n## Summary\n\n";
const CHAT_HISTORY_SCHEMA = "opencode-chat-message-block-v1";
const DEFAULT_SUMMARY = "Pending summary.";
const LLM_STATS_FILENAME = "LLM_STATS.json";
const TURN_METADATA_FILENAME_SUFFIX = ".json";
const TURN_PATTERN =
  /^## \[(?<timestamp>[^\]]+)\] (?<sender>[^\n]+)\n\n(?<body>[\s\S]*)\n---\n?$/;

export interface SaveChatTurnInput {
  agentId: string;
  sender: TurnSender;
  bodyMarkdown: string;
  thinkingMarkdown?: string;
  title?: string;
  sessionId?: string;
  summary?: string;
  createdAt?: string;
  startedAt?: string;
  runtimeConfig?: ChatRuntimeConfig;
  attachment?: AttachmentUpload;
}

export async function listSessions(
  workspace: MinKbWorkspace,
  agentId: string
): Promise<ChatSessionSummary[]> {
  const historyRoot = historyRootForAgent(workspace, agentId);
  const manifests = (await walkFiles(historyRoot)).filter(
    (filePath) => path.basename(filePath) === "SESSION.md"
  );
  const sessions = await Promise.all(
    manifests.map((manifestPath) => readSessionSummary(workspace, manifestPath))
  );

  return sessions.sort((left, right) =>
    right.startedAt.localeCompare(left.startedAt)
  );
}

export async function getSession(
  workspace: MinKbWorkspace,
  agentId: string,
  sessionId: string
): Promise<ChatSession> {
  const manifestPath = await findSessionManifest(workspace, agentId, sessionId);
  if (!manifestPath) {
    throw new Error(`Session not found for agent ${agentId}: ${sessionId}`);
  }

  const summary = await readSessionSummary(workspace, manifestPath);
  const turnsRoot = path.join(path.dirname(manifestPath), "turns");
  const turnFiles = (await walkFiles(turnsRoot)).filter((filePath) =>
    filePath.endsWith(".md")
  );
  turnFiles.sort((left, right) => left.localeCompare(right));

  const turns = await Promise.all(
    turnFiles.map((turnFile) => parseTurn(workspace, turnFile))
  );

  return {
    ...summary,
    turns,
  };
}

export async function saveChatTurn(
  workspace: MinKbWorkspace,
  input: SaveChatTurnInput
): Promise<ChatSession> {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const normalizedAgentId = normalizeAgentId(input.agentId);
  const session = await ensureSession(workspace, {
    agentId: normalizedAgentId,
    title: input.title,
    sessionId: input.sessionId,
    startedAt: input.startedAt ?? createdAt,
    summary: input.summary,
  });

  const sender = senderSchema.parse(input.sender);
  const turnsRoot = path.join(
    path.dirname(resolveManifestPath(workspace, session)),
    "turns"
  );
  const sessionDirectory = path.dirname(
    resolveManifestPath(workspace, session)
  );
  await fs.mkdir(turnsRoot, { recursive: true });
  const turnPath = path.join(turnsRoot, turnFilename(createdAt, sender));
  const thinkingMarkdown = input.thinkingMarkdown?.trimEnd();
  const attachment = input.attachment
    ? await writeTurnAttachment(
        workspace,
        sessionDirectory,
        path.basename(turnPath, ".md"),
        input.attachment
      )
    : undefined;
  await fs.writeFile(
    turnPath,
    renderTurn(sender, input.bodyMarkdown, createdAt),
    "utf8"
  );
  const metadata = {
    ...(attachment ? { attachment } : {}),
    ...(thinkingMarkdown ? { thinkingMarkdown } : {}),
  };
  if (Object.keys(metadata).length > 0) {
    await fs.writeFile(
      turnMetadataPath(turnPath),
      `${JSON.stringify(metadata, null, 2)}\n`,
      "utf8"
    );
  }

  if (input.summary !== undefined) {
    await updateSessionSummary(
      workspace,
      session.agentId,
      session.sessionId,
      input.summary
    );
  }

  if (input.runtimeConfig) {
    await writeRuntimeConfig(
      path.dirname(resolveManifestPath(workspace, session)),
      input.runtimeConfig
    );
  }

  return getSession(workspace, normalizedAgentId, session.sessionId);
}

export async function updateSessionSummary(
  workspace: MinKbWorkspace,
  agentId: string,
  sessionId: string,
  summary: string
): Promise<void> {
  const manifestPath = await findSessionManifest(workspace, agentId, sessionId);
  if (!manifestPath) {
    throw new Error(
      `Cannot update missing session ${sessionId} for agent ${agentId}`
    );
  }

  const session = await parseSessionManifest(workspace, manifestPath);
  await fs.writeFile(
    manifestPath,
    renderSessionManifest(
      session.sessionId,
      session.agentId,
      session.title,
      session.startedAt,
      summary
    ),
    "utf8"
  );
}

export async function deleteSession(
  workspace: MinKbWorkspace,
  agentId: string,
  sessionId: string
): Promise<void> {
  const manifestPath = await findSessionManifest(workspace, agentId, sessionId);
  if (!manifestPath) {
    throw new Error(
      `Cannot delete missing session ${sessionId} for ${agentId}`
    );
  }

  await fs.rm(path.dirname(manifestPath), { recursive: true, force: true });
}

export async function recordSessionLlmUsage(
  workspace: MinKbWorkspace,
  agentId: string,
  sessionId: string,
  usage: LlmRequestStats
): Promise<LlmSessionStats> {
  const manifestPath = await findSessionManifest(workspace, agentId, sessionId);
  if (!manifestPath) {
    throw new Error(
      `Cannot record LLM stats for missing session ${sessionId} for agent ${agentId}`
    );
  }

  const sessionDirectory = path.dirname(manifestPath);
  const current = await readLlmStats(sessionDirectory);
  const next = accumulateLlmSessionStats(current, usage);
  await writeLlmStats(sessionDirectory, next);
  return next;
}

async function ensureSession(
  workspace: MinKbWorkspace,
  input: {
    agentId: string;
    title?: string;
    sessionId?: string;
    startedAt: string;
    summary?: string;
  }
): Promise<ChatSessionSummary> {
  const title = input.title ?? humanizeSessionId(input.sessionId);
  if (!title) {
    throw new Error("A title is required when creating a new session.");
  }

  const sessionId =
    input.sessionId ?? sessionIdFromTitle(title, input.startedAt);
  const existingManifest = await findSessionManifest(
    workspace,
    input.agentId,
    sessionId
  );
  if (existingManifest) {
    return readSessionSummary(workspace, existingManifest);
  }

  const sessionDirectory = path.join(
    historyRootForAgent(workspace, input.agentId),
    input.startedAt.slice(0, 7),
    sessionId
  );
  await fs.mkdir(path.join(sessionDirectory, "turns"), { recursive: true });
  const manifestPath = path.join(sessionDirectory, "SESSION.md");
  await fs.writeFile(
    manifestPath,
    renderSessionManifest(
      sessionId,
      input.agentId,
      title,
      input.startedAt,
      input.summary ?? DEFAULT_SUMMARY
    ),
    "utf8"
  );

  return readSessionSummary(workspace, manifestPath);
}

async function readSessionSummary(
  workspace: MinKbWorkspace,
  manifestPath: string
): Promise<ChatSessionSummary> {
  const base = await parseSessionManifest(workspace, manifestPath);
  const turnsRoot = path.join(path.dirname(manifestPath), "turns");
  const turnFiles = (await walkFiles(turnsRoot)).filter((filePath) =>
    filePath.endsWith(".md")
  );
  turnFiles.sort((left, right) => left.localeCompare(right));
  const lastTurnPath = turnFiles.at(-1);
  const runtimeConfig = await readRuntimeConfig(path.dirname(manifestPath));
  const llmStats = await readLlmStats(path.dirname(manifestPath));

  return {
    ...base,
    manifestPath: toPosixRelative(workspace.storeRoot, manifestPath),
    turnCount: turnFiles.length,
    lastTurnAt: lastTurnPath ? createdAtFromTurnPath(lastTurnPath) : undefined,
    runtimeConfig,
    llmStats,
  };
}

async function parseSessionManifest(
  _workspace: MinKbWorkspace,
  manifestPath: string
): Promise<
  Omit<
    ChatSessionSummary,
    "turnCount" | "lastTurnAt" | "runtimeConfig" | "manifestPath"
  >
> {
  const raw = await fs.readFile(manifestPath, "utf8");
  if (!raw.startsWith(SESSION_HEADER)) {
    throw new Error(`Invalid session manifest header: ${manifestPath}`);
  }

  const summaryIndex = raw.indexOf(SUMMARY_MARKER);
  if (summaryIndex === -1) {
    throw new Error(`Missing summary section in ${manifestPath}`);
  }
  const metadataBlock = raw.slice(0, summaryIndex);
  const summary = raw.slice(summaryIndex + SUMMARY_MARKER.length);

  const lines = metadataBlock
    .split("\n")
    .filter((line) => line.trim().length > 0);
  const title = lines[0]?.slice(SESSION_HEADER.length).trim();
  const metadata = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex === -1) {
      continue;
    }
    const key = line
      .slice(0, separatorIndex)
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "_");
    const value = line.slice(separatorIndex + 1).trim();
    metadata.set(key, value);
  }

  const sessionId = metadata.get("session_id");
  const agentId = metadata.get("agent");
  const startedAt = metadata.get("started");
  if (!title || !sessionId || !agentId || !startedAt) {
    throw new Error(`Incomplete session metadata in ${manifestPath}`);
  }

  const normalizedAgentId = normalizeAgentId(agentId);
  if (!manifestPath.includes(path.join("agents", normalizedAgentId))) {
    throw new Error(
      `Manifest path does not match agent ${normalizedAgentId}: ${manifestPath}`
    );
  }

  return {
    sessionId,
    agentId: normalizedAgentId,
    title,
    startedAt,
    summary: summary.trim() || DEFAULT_SUMMARY,
  };
}

async function parseTurn(
  workspace: MinKbWorkspace,
  turnPath: string
): Promise<ChatTurn> {
  const raw = await fs.readFile(turnPath, "utf8");
  const match = raw.match(TURN_PATTERN);
  if (!match?.groups) {
    throw new Error(`Invalid turn file: ${turnPath}`);
  }
  const sender = match.groups.sender;
  const bodyMarkdown = match.groups.body;
  if (!sender || bodyMarkdown === undefined) {
    throw new Error(`Incomplete turn file: ${turnPath}`);
  }

  const metadataRaw = await readOptionalFile(turnMetadataPath(turnPath));
  const parsedMetadata = metadataRaw
    ? (JSON.parse(metadataRaw) as {
        attachment?: unknown;
        thinkingMarkdown?: unknown;
      })
    : undefined;
  const attachment = parsedMetadata?.attachment
    ? storedAttachmentSchema.parse(parsedMetadata.attachment)
    : undefined;
  const thinkingMarkdown =
    typeof parsedMetadata?.thinkingMarkdown === "string"
      ? parsedMetadata.thinkingMarkdown
      : undefined;

  return {
    messageId: path.basename(turnPath, ".md"),
    sender: senderSchema.parse(sender.trim()) as TurnSender,
    createdAt: createdAtFromTurnPath(turnPath),
    bodyMarkdown: bodyMarkdown.trimEnd(),
    ...(thinkingMarkdown ? { thinkingMarkdown } : {}),
    relativePath: toPosixRelative(workspace.storeRoot, turnPath),
    ...(attachment ? { attachment } : {}),
  };
}

async function findSessionManifest(
  workspace: MinKbWorkspace,
  agentId: string,
  sessionId: string
): Promise<string | undefined> {
  const historyRoot = historyRootForAgent(workspace, agentId);
  const manifests = (await walkFiles(historyRoot)).filter((filePath) =>
    filePath.endsWith(`${path.sep}${sessionId}${path.sep}SESSION.md`)
  );

  if (manifests.length > 1) {
    throw new Error(
      `Multiple sessions matched ${sessionId} for agent ${agentId}: ${manifests.join(", ")}`
    );
  }

  return manifests[0];
}

function historyRootForAgent(
  workspace: MinKbWorkspace,
  agentId: string
): string {
  return path.join(workspace.agentsRoot, normalizeAgentId(agentId), "history");
}

function resolveManifestPath(
  workspace: MinKbWorkspace,
  session: Pick<ChatSessionSummary, "agentId" | "manifestPath">
): string {
  return path.join(workspace.storeRoot, session.manifestPath);
}

export function sessionIdFromTitle(title: string, startedAt: string): string {
  return `${startedAt.slice(0, 10)}-${slugify(title)}`;
}

export function turnFilename(createdAt: string, sender: TurnSender): string {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 8);
  return `${compactTimestamp(createdAt)}-${slugify(sender)}-${suffix}.md`;
}

function createdAtFromTurnPath(turnPath: string): string {
  const base = path.basename(turnPath, ".md");
  const compact = base.split("-")[0];
  if (!compact) {
    throw new Error(`Cannot derive timestamp from turn path: ${turnPath}`);
  }
  return isoFromCompactTimestamp(compact);
}

function renderSessionManifest(
  sessionId: string,
  agentId: string,
  title: string,
  startedAt: string,
  summary: string
): string {
  const manifest = [
    `${SESSION_HEADER}${title}`,
    `Session ID: ${sessionId}`,
    `Agent: ${agentId}`,
    `Started: ${startedAt}`,
    `Schema: ${CHAT_HISTORY_SCHEMA}`,
    "Rendering: Sort `turns/*.md` lexically and render each file in order.",
    "Storage Model: Session metadata stays in this file. Each turn is an immutable Markdown file under `turns`.",
    "",
    "## Summary",
    "",
    summary.trim() || DEFAULT_SUMMARY,
  ].join("\n");

  return ensureTrailingNewline(manifest);
}

function renderTurn(
  sender: TurnSender,
  bodyMarkdown: string,
  createdAt: string
): string {
  return ensureTrailingNewline(
    [
      `## [${displayTimestamp(createdAt)}] ${sender}`,
      "",
      bodyMarkdown.trimEnd(),
      "---",
    ].join("\n")
  );
}

function turnMetadataPath(turnPath: string): string {
  return `${turnPath}${TURN_METADATA_FILENAME_SUFFIX}`;
}

async function writeTurnAttachment(
  workspace: MinKbWorkspace,
  sessionDirectory: string,
  messageId: string,
  attachment: AttachmentUpload
): Promise<StoredAttachment> {
  const normalized = attachmentUploadSchema.parse(attachment);
  const attachmentId = randomUUID().replace(/-/g, "");
  const attachmentDirectory = path.join(
    sessionDirectory,
    "attachments",
    messageId
  );
  await fs.mkdir(attachmentDirectory, { recursive: true });

  const normalizedFilename = buildAttachmentFilename(normalized.name);
  const attachmentPath = path.join(attachmentDirectory, normalizedFilename);
  const buffer = Buffer.from(normalized.base64Data, "base64");
  await fs.writeFile(attachmentPath, buffer);

  return storedAttachmentSchema.parse({
    attachmentId,
    name: normalized.name,
    contentType: normalized.contentType,
    size: buffer.length,
    mediaType: classifyAttachmentMediaType(normalized.contentType),
    relativePath: toPosixRelative(workspace.storeRoot, attachmentPath),
  });
}

function buildAttachmentFilename(name: string): string {
  const extension = path.extname(name).toLowerCase();
  const stem = path.basename(name, extension);
  const normalizedStem = slugify(stem) || "attachment";
  return `${normalizedStem}${extension}`;
}

function classifyAttachmentMediaType(
  contentType: string
): StoredAttachment["mediaType"] {
  if (contentType.startsWith("image/")) {
    return "image";
  }
  if (
    contentType.startsWith("text/") ||
    contentType.includes("json") ||
    contentType.includes("xml")
  ) {
    return "text";
  }
  return "binary";
}

function humanizeSessionId(sessionId?: string): string | undefined {
  if (!sessionId) {
    return undefined;
  }

  const parts = sessionId.split("-");
  if (
    parts.length > 3 &&
    /^\d{4}$/.test(parts[0] ?? "") &&
    /^\d{2}$/.test(parts[1] ?? "") &&
    /^\d{2}$/.test(parts[2] ?? "")
  ) {
    return parts
      .slice(3)
      .join(" ")
      .replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  return sessionId
    .replace(/-/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

async function readRuntimeConfig(
  sessionDirectory: string
): Promise<ChatRuntimeConfig | undefined> {
  const raw = await readOptionalFile(
    path.join(sessionDirectory, "RUNTIME.json")
  );
  if (!raw) {
    return undefined;
  }

  return chatRuntimeConfigSchema.parse(JSON.parse(raw));
}

async function writeRuntimeConfig(
  sessionDirectory: string,
  runtimeConfig: ChatRuntimeConfig
): Promise<void> {
  const normalized = chatRuntimeConfigSchema.parse(runtimeConfig);
  await fs.writeFile(
    path.join(sessionDirectory, "RUNTIME.json"),
    `${JSON.stringify(normalized, null, 2)}\n`,
    "utf8"
  );
}

async function readLlmStats(
  sessionDirectory: string
): Promise<LlmSessionStats | undefined> {
  const raw = await readOptionalFile(
    path.join(sessionDirectory, LLM_STATS_FILENAME)
  );
  if (!raw) {
    return undefined;
  }

  return llmSessionStatsSchema.parse(JSON.parse(raw));
}

async function writeLlmStats(
  sessionDirectory: string,
  stats: LlmSessionStats
): Promise<void> {
  const normalized = llmSessionStatsSchema.parse(stats);
  await fs.writeFile(
    path.join(sessionDirectory, LLM_STATS_FILENAME),
    `${JSON.stringify(normalized, null, 2)}\n`,
    "utf8"
  );
}

function accumulateLlmSessionStats(
  current: LlmSessionStats | undefined,
  usage: LlmRequestStats
): LlmSessionStats {
  const normalizedCurrent = llmSessionStatsSchema.parse(current ?? {});
  const normalizedUsage = llmRequestStatsSchema.parse(usage);

  return llmSessionStatsSchema.parse({
    requestCount: normalizedCurrent.requestCount + normalizedUsage.requestCount,
    inputTokens: normalizedCurrent.inputTokens + normalizedUsage.inputTokens,
    outputTokens: normalizedCurrent.outputTokens + normalizedUsage.outputTokens,
    totalDurationMs:
      normalizedCurrent.totalDurationMs + normalizedUsage.durationMs,
    lastRecordedAt: normalizedUsage.recordedAt,
    lastModel: normalizedUsage.model,
    lastTokensPerSecond:
      normalizedUsage.tokensPerSecond ?? normalizedCurrent.lastTokensPerSecond,
  });
}
