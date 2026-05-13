import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  AgentSummary,
  ChatRuntimeConfig,
  SkillDescriptor,
  SkillScope,
} from "@gemma-agent-pwa/contracts";
import matter from "gray-matter";
import { parsePersistedRuntimeConfig } from "./runtime-config.js";
import { listSessions } from "./sessions.js";
import {
  firstParagraph,
  normalizeAgentId,
  pathExists,
  readDirNames,
  readOptionalFile,
  walkFiles,
} from "./utils.js";
import type { MinKbWorkspace } from "./workspace.js";

const SKILL_SCRIPT_NAMES = [
  "run.sh",
  "run.py",
  "run.js",
  "run.ts",
  "run",
] as const;
const SUPPORTED_SKILL_SCRIPT_EXTENSIONS = new Set([".sh", ".py", ".js", ".ts"]);

interface MarkdownDocument {
  content: string;
  data: Record<string, unknown>;
}

export async function listAgents(
  workspace: MinKbWorkspace
): Promise<AgentSummary[]> {
  const agentDirectories = await readDirNames(workspace.agentsRoot);
  const agents: AgentSummary[] = [];

  for (const agentDirectory of agentDirectories) {
    if (agentDirectory === "default") {
      continue;
    }

    const bundle = await getAgentById(workspace, agentDirectory);
    if (bundle) {
      agents.push(bundle);
    }
  }

  return agents.sort((left, right) => left.title.localeCompare(right.title));
}

export async function getAgentById(
  workspace: MinKbWorkspace,
  agentId: string
): Promise<AgentSummary | undefined> {
  const normalizedAgentId = normalizeAgentId(agentId);
  const agentRoot = path.join(workspace.agentsRoot, normalizedAgentId);
  const agentPath = path.join(agentRoot, "AGENT.md");
  const defaultSoulPath = path.join(workspace.agentsRoot, "default", "SOUL.md");
  const soulPath = path.join(agentRoot, "SOUL.md");
  const runtimeConfigPath = path.join(agentRoot, "RUNTIME.json");
  const historyRoot = path.join(agentRoot, "history");
  const workingMemoryRoot = path.join(agentRoot, "memory", "working");
  const skillRoot = path.join(agentRoot, "skills");

  if (!(await pathExists(agentPath))) {
    return undefined;
  }

  const [
    agentDocument,
    defaultSoul,
    soul,
    runtimeConfig,
    skills,
    sessionCount,
  ] = await Promise.all([
    readMarkdownDocument(agentPath),
    readMarkdownDocument(defaultSoulPath),
    readMarkdownDocumentIfExists(soulPath),
    readRuntimeConfigIfExists(runtimeConfigPath),
    listSkillsForAgent(workspace, normalizedAgentId),
    countAgentSessions(workspace, normalizedAgentId),
  ]);

  const title =
    typeof agentDocument.data.title === "string"
      ? agentDocument.data.title
      : `${normalizedAgentId.replace(/-/g, " ")} agent`;
  const kind = normalizeAgentKind(agentDocument.data);
  const delegatedAgentIds = await resolveDelegatedAgentIds(
    workspace,
    normalizedAgentId,
    kind,
    agentDocument.data
  );
  const description = firstParagraph(agentDocument.content);
  const combinedPrompt = composeAgentPrompt({
    defaultSoul: defaultSoul.content,
    agentContract: agentDocument.content,
    agentSoul: soul?.content,
    kind,
    delegatedAgentIds,
    skillNames: skills.map((skill) => skill.name),
  });

  return {
    id: normalizedAgentId,
    kind,
    title,
    description,
    combinedPrompt,
    agentPath,
    defaultSoulPath,
    soulPath: soul ? soulPath : undefined,
    historyRoot,
    workingMemoryRoot,
    skillRoot,
    skillNames: skills.map((skill) => skill.name),
    delegatedAgentIds,
    sessionCount,
    runtimeConfig,
  };
}

export async function listSkillsForAgent(
  workspace: MinKbWorkspace,
  agentId: string
): Promise<SkillDescriptor[]> {
  const normalizedAgentId = normalizeAgentId(agentId);
  const roots: Array<{ root: string; scope: SkillScope }> = [
    { root: workspace.copilotSkillsRoot, scope: "copilot-global" },
    { root: workspace.skillsRoot, scope: "store-global" },
    {
      root: path.join(workspace.agentsRoot, normalizedAgentId, "skills"),
      scope: "agent-local",
    },
  ];

  const byName = new Map<string, SkillDescriptor>();
  for (const candidate of roots) {
    const descriptors = await readSkillDescriptors(
      candidate.root,
      candidate.scope
    );
    for (const descriptor of descriptors) {
      byName.set(descriptor.name, descriptor);
    }
  }

  return [...byName.values()].sort((left, right) =>
    left.name.localeCompare(right.name)
  );
}

export interface LoadedSkillDocument extends SkillDescriptor {
  content: string;
}

export async function loadEnabledSkillDocumentsForAgent(
  workspace: MinKbWorkspace,
  agentId: string,
  disabledSkillNames: string[] = []
): Promise<LoadedSkillDocument[]> {
  const disabledSkillNameSet = new Set(disabledSkillNames);
  const skills = await listSkillsForAgent(workspace, agentId);
  const loadedSkills: LoadedSkillDocument[] = [];

  for (const skill of skills) {
    if (disabledSkillNameSet.has(skill.name)) {
      continue;
    }

    const document = await readMarkdownDocument(skill.path);
    loadedSkills.push({
      ...skill,
      content: document.content,
    });
  }

  return loadedSkills;
}

export function composeAgentPrompt(input: {
  defaultSoul: string;
  agentContract: string;
  agentSoul?: string;
  kind: AgentSummary["kind"];
  delegatedAgentIds: string[];
  skillNames: string[];
}): string {
  const delegationSection =
    input.delegatedAgentIds.length > 0 ||
    input.kind === "planner" ||
    input.kind === "orchestrator"
      ? [
          "## Execution mode",
          "",
          `Agent type: ${input.kind}`,
          input.delegatedAgentIds.length > 0
            ? [
                "Delegation is available through the `delegate-task` tool.",
                "Use it as the preferred path for work that should be handled by another agent, and wait for the tool result before continuing.",
                `Allowed delegated agents: ${input.delegatedAgentIds.join(", ")}.`,
              ].join("\n")
            : "Delegation is not configured for this agent.",
        ].join("\n")
      : undefined;

  const sections = [
    "You are a custom agent loaded from min-kb-store. Follow the layered Markdown contract below.",
    `## Default persona\n\n${input.defaultSoul.trim()}`,
    `## Agent contract\n\n${input.agentContract.trim()}`,
    input.agentSoul
      ? `## Agent persona\n\n${input.agentSoul.trim()}`
      : undefined,
    input.skillNames.length > 0
      ? `## Available skill names\n\n${input.skillNames.map((skillName) => `- ${skillName}`).join("\n")}`
      : undefined,
    delegationSection,
  ].filter((section): section is string => Boolean(section));

  return `${sections.join("\n\n")}\n`;
}

function normalizeAgentKind(
  metadata: Record<string, unknown>
): AgentSummary["kind"] {
  const candidates = [
    metadata.kind,
    metadata.agentType,
    metadata.agent_type,
    metadata.type,
  ].filter((value): value is string => typeof value === "string");
  const normalized = candidates[0]?.trim().toLowerCase();
  if (
    normalized === "planner" ||
    normalized === "orchestrator" ||
    normalized === "chat"
  ) {
    return normalized;
  }
  return "chat";
}

function parseDelegatedAgentIds(metadata: Record<string, unknown>): string[] {
  const candidates = [
    metadata.delegatedAgentIds,
    metadata.delegatedAgents,
    metadata.delegatesTo,
    metadata.delegates_to,
    metadata.delegatesToAgentIds,
    metadata.taskerAgentIds,
    metadata.taskerAgents,
    metadata.delegates,
  ];
  for (const candidate of candidates) {
    const parsed = parseDelegatedAgentIdsValue(candidate);
    if (parsed.length > 0) {
      return parsed;
    }
  }
  return [];
}

async function resolveDelegatedAgentIds(
  workspace: MinKbWorkspace,
  agentId: string,
  kind: AgentSummary["kind"],
  metadata: Record<string, unknown>
): Promise<string[]> {
  const availableAgentIds = new Set(
    (await readDirNames(workspace.agentsRoot))
      .filter((candidate) => candidate !== "default")
      .map((candidate) => normalizeAgentId(candidate))
  );
  const configuredDelegates = parseDelegatedAgentIds(metadata);
  if (configuredDelegates.length > 0) {
    return configuredDelegates.map((candidate) =>
      resolveAgentReferenceId(candidate, availableAgentIds)
    );
  }

  if (kind === "orchestrator") {
    return [];
  }

  return [...availableAgentIds]
    .filter((candidate) => candidate.length > 0 && candidate !== agentId)
    .sort((left, right) => left.localeCompare(right));
}

function resolveAgentReferenceId(
  candidate: string,
  availableAgentIds: Set<string>
): string {
  if (availableAgentIds.has(candidate)) {
    return candidate;
  }

  if (candidate.startsWith("agent-")) {
    const unprefixedCandidate = candidate.slice("agent-".length);
    if (availableAgentIds.has(unprefixedCandidate)) {
      return unprefixedCandidate;
    }
  }

  return candidate;
}

function parseDelegatedAgentIdsValue(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => normalizeAgentId(entry))
      .filter((entry) => entry.length > 0);
  }

  if (typeof value === "string") {
    return value
      .split(",")
      .map((entry) => normalizeAgentId(entry))
      .filter((entry) => entry.length > 0);
  }

  return [];
}

async function readSkillDescriptors(
  root: string,
  scope: SkillScope
): Promise<SkillDescriptor[]> {
  if (!(await pathExists(root))) {
    return [];
  }

  const files = (await walkFiles(root)).filter(
    (filePath) => path.basename(filePath) === "SKILL.md"
  );
  const descriptors: SkillDescriptor[] = [];

  for (const filePath of files) {
    const document = await readMarkdownDocument(filePath);
    const fallbackName = path.basename(path.dirname(filePath));
    const name =
      typeof document.data.name === "string"
        ? document.data.name
        : fallbackName;
    const description =
      typeof document.data.description === "string"
        ? document.data.description
        : firstParagraph(document.content);

    const skillDir = path.dirname(filePath);
    const scriptPath = await findSkillScript(skillDir);

    descriptors.push({
      name,
      description,
      scope,
      path: filePath,
      sourceRoot: root,
      hasScript: scriptPath !== undefined,
      ...(scriptPath ? { scriptPath } : {}),
    });
  }

  return descriptors.sort((left, right) => left.name.localeCompare(right.name));
}

async function findSkillScript(skillDir: string): Promise<string | undefined> {
  for (const scriptName of SKILL_SCRIPT_NAMES) {
    const candidate = path.join(skillDir, scriptName);
    if (await pathExists(candidate)) {
      return candidate;
    }
  }

  const scriptsDir = path.join(skillDir, "scripts");
  if (!(await pathExists(scriptsDir))) {
    return undefined;
  }

  const entries = await fs.readdir(scriptsDir, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(scriptsDir, entry.name))
    .filter((candidate) => {
      const extension = path.extname(candidate).toLowerCase();
      return (
        SUPPORTED_SKILL_SCRIPT_EXTENSIONS.has(extension) ||
        path.basename(candidate) === "run"
      );
    })
    .sort((left, right) => left.localeCompare(right));

  return candidates.length === 1 ? candidates[0] : undefined;
}

async function readMarkdownDocument(
  filePath: string
): Promise<MarkdownDocument> {
  const raw = await fs.readFile(filePath, "utf8");
  const parsed = matter(raw);
  return {
    content: parsed.content.trim(),
    data: parsed.data as Record<string, unknown>,
  };
}

async function readMarkdownDocumentIfExists(
  filePath: string
): Promise<MarkdownDocument | undefined> {
  const raw = await readOptionalFile(filePath);
  if (raw === undefined) {
    return undefined;
  }

  const parsed = matter(raw);
  return {
    content: parsed.content.trim(),
    data: parsed.data as Record<string, unknown>,
  };
}

async function readRuntimeConfigIfExists(
  filePath: string
): Promise<ChatRuntimeConfig | undefined> {
  const raw = await readOptionalFile(filePath);
  if (raw === undefined) {
    return undefined;
  }

  return parsePersistedRuntimeConfig(raw);
}

async function countAgentSessions(
  workspace: MinKbWorkspace,
  agentId: string
): Promise<number> {
  return (await listSessions(workspace, agentId)).length;
}
