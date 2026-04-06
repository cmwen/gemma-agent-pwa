import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  AgentSummary,
  ChatRuntimeConfig,
  SkillDescriptor,
  SkillScope,
} from "@gemma-agent-pwa/contracts";
import { chatRuntimeConfigSchema } from "@gemma-agent-pwa/contracts";
import matter from "gray-matter";
import {
  firstParagraph,
  normalizeAgentId,
  pathExists,
  readDirNames,
  readOptionalFile,
  walkFiles,
} from "./utils.js";
import type { MinKbWorkspace } from "./workspace.js";

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
    countAgentSessions(historyRoot),
  ]);

  const title =
    typeof agentDocument.data.title === "string"
      ? agentDocument.data.title
      : `${normalizedAgentId.replace(/-/g, " ")} agent`;
  const description = firstParagraph(agentDocument.content);
  const combinedPrompt = composeAgentPrompt({
    defaultSoul: defaultSoul.content,
    agentContract: agentDocument.content,
    agentSoul: soul?.content,
    skillNames: skills.map((skill) => skill.name),
  });

  return {
    id: normalizedAgentId,
    kind: "chat",
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
  skillNames: string[];
}): string {
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
  ].filter((section): section is string => Boolean(section));

  return `${sections.join("\n\n")}\n`;
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

    descriptors.push({
      name,
      description,
      scope,
      path: filePath,
      sourceRoot: root,
    });
  }

  return descriptors.sort((left, right) => left.name.localeCompare(right.name));
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

  return chatRuntimeConfigSchema.parse(JSON.parse(raw));
}

async function countAgentSessions(historyRoot: string): Promise<number> {
  if (!(await pathExists(historyRoot))) {
    return 0;
  }

  const files = await walkFiles(historyRoot);
  return files.filter((filePath) => path.basename(filePath) === "SESSION.md")
    .length;
}
