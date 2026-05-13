import { spawn } from "node:child_process";
import path from "node:path";
import type { ChatTool } from "@gemma-agent-pwa/contracts";
import type { MinKbWorkspace } from "@gemma-agent-pwa/min-kb-bridge";
import {
  type LoadedSkillDocument,
  loadEnabledSkillDocumentsForAgent,
} from "@gemma-agent-pwa/min-kb-bridge";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 64_000;
const MAX_SKILL_GUIDANCE_PARAGRAPHS = 3;
const MAX_SKILL_GUIDANCE_CHARS = 900;
const XML_SKILL_CALL_PATTERN =
  /<skill_call\s+name="([^"]+)">([\s\S]*?)<\/skill_call>/g;
const INLINE_SKILL_CALL_PATTERN =
  /^\s*skill_call\s*:\s*([A-Za-z0-9_.-]+)\s*(.*)$/gm;
const LEGACY_TOOL_CALL_PATTERN =
  /<\|tool_call>\s*call(?:\s*:\s*|\s+)([A-Za-z0-9_.-]+)([\s\S]*?)(?:<\|tool_call\|>|<tool_call\|>|<\/tool_call>)/g;
const LEGACY_QUOTE_TOKEN = '<|"|>';
const SKILL_INPUT_JSON_ENV_KEY = "SKILL_INPUT_JSON";

export interface SkillCallRequest {
  skillName: string;
  input: string;
}

export interface SkillCallResult {
  skillName: string;
  output: string;
  exitCode: number;
}

export async function loadAgentSkills(
  workspace: MinKbWorkspace,
  agentId: string,
  disabledSkillNames: string[] = []
): Promise<LoadedSkillDocument[]> {
  return loadEnabledSkillDocumentsForAgent(
    workspace,
    agentId,
    disabledSkillNames
  );
}

export function buildExecutableSkillInstructions(
  enabledSkills: LoadedSkillDocument[]
): string | undefined {
  const executableSkills = enabledSkills.filter((skill) => skill.hasScript);
  if (executableSkills.length === 0) {
    return undefined;
  }

  return [
    "## Skill execution",
    "",
    "You have access to executable skills. To run a skill, emit a skill_call block:",
    "",
    "```",
    '<skill_call name="skill-name">input for the skill</skill_call>',
    "```",
    "",
    "When you need a skill, respond with skill_call block(s) only. Do not add preambles, reasoning, markdown fences, or any other visible text in that same message.",
    "If the latest user message already gives you enough detail to use a skill, call it directly instead of asking a follow-up question.",
    "The system will execute the skill and return its output.",
    "When a skill needs a single free-form or positional input such as a search query, topic, or file path, pass plain text inside the skill_call body instead of wrapping it in JSON.",
    'When a skill needs named inputs like type, title, body, path, or agentId, prefer a JSON object body such as {"type":"working","title":"Run plan"}. This is more reliable than hand-written CLI flags.',
    "The runtime forwards top-level JSON fields as CLI flags such as --field value for legacy scripts, so prefer JSON over hand-written --flag value text unless the skill explicitly requires exact CLI syntax.",
    "After you receive skill results, continue working toward the user's request. If the result is sufficient, answer the user directly in plain language. If you still need another executable skill, emit the next skill_call block(s) only. Do not expose chain-of-thought, reasoning traces, or raw tool-call markup.",
    "Only call skills that are listed below as executable. Treat every other skill as reference-only context.",
    "",
    "### Executable skills",
    ...executableSkills.map((skill) => {
      const summary = summarizeSkillBody(skill.content);
      return summary
        ? `- **${skill.name}**: ${summary}`
        : `- **${skill.name}**`;
    }),
  ].join("\n");
}

export function buildSkillsPromptSections(
  enabledSkills: LoadedSkillDocument[]
): string | undefined {
  if (enabledSkills.length === 0) {
    return undefined;
  }

  return [
    "## Enabled skills",
    ...enabledSkills.map((skill) => buildSkillPromptSection(skill)),
  ].join("\n\n");
}

export function buildToolPromptSections(
  tools: ChatTool[] = []
): string | undefined {
  if (tools.length === 0) {
    return undefined;
  }

  return [
    "## Available tools",
    "To use a tool, emit a skill_call block with the tool name and the tool input body. The runtime will execute the tool and return the result before you continue.",
    "Tools listed here are executable even when they do not appear in the executable-skill count below.",
    ...tools.map((tool) => buildToolPromptSection(tool)),
  ].join("\n\n");
}

function buildSkillPromptSection(skill: LoadedSkillDocument): string {
  const summary = summarizeSkillBody(skill.content);
  const guidance = extractSkillGuidance(skill.content, summary);

  return [
    `### ${skill.name}`,
    skill.hasScript
      ? "Executable in this runtime."
      : "Reference-only in this runtime. Do not call it as a tool.",
    summary ? `Summary: ${summary}` : undefined,
    guidance ? `Guidance:\n${indentBlock(guidance, "  ")}` : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function buildToolPromptSection(tool: ChatTool): string {
  const metadata = tool.metadata ?? {};
  const allowedAgentIds = Array.isArray(metadata.delegatedAgentIds)
    ? metadata.delegatedAgentIds.filter(
        (entry): entry is string => typeof entry === "string"
      )
    : [];
  const parameters =
    tool.parameters !== undefined && typeof tool.parameters === "object"
      ? JSON.stringify(tool.parameters, null, 2)
      : tool.parameters !== undefined
        ? String(tool.parameters)
        : undefined;

  return [
    `### ${tool.name}`,
    metadata.kind === "delegation"
      ? "Important delegation tool."
      : "Available tool.",
    tool.description,
    metadata.kind === "delegation"
      ? [
          "Use this tool whenever another agent should perform the work.",
          "Do not simulate delegation by storing notes, writing memory, or calling non-delegation skills as a handoff.",
          'Prefer a JSON body such as {"agentId":"qa-tasker","prompt":"Check the release checklist."} and wait for the returned result before continuing.',
        ].join(" ")
      : undefined,
    allowedAgentIds.length > 0
      ? `Allowed delegated agents: ${allowedAgentIds.join(", ")}.`
      : undefined,
    parameters ? `Parameters:\n${indentBlock(parameters, "  ")}` : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function summarizeSkillBody(content: string): string | undefined {
  return getSkillParagraphs(content)[0];
}

function extractSkillGuidance(
  content: string,
  summary: string | undefined
): string | undefined {
  const paragraphs = getSkillParagraphs(content).filter(
    (paragraph) =>
      !summary ||
      normalizeForComparison(paragraph) !== normalizeForComparison(summary)
  );

  if (paragraphs.length === 0) {
    return undefined;
  }

  const guidance = paragraphs
    .slice(0, MAX_SKILL_GUIDANCE_PARAGRAPHS)
    .join("\n\n");
  return truncateForPrompt(guidance, MAX_SKILL_GUIDANCE_CHARS);
}

function getSkillParagraphs(content: string): string[] {
  return content
    .split(/\n\s*\n/g)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
}

function indentBlock(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function normalizeForComparison(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function truncateForPrompt(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength - 14).trimEnd()}… [truncated]`;
}

export function parseSkillCalls(text: string): SkillCallRequest[] {
  const calls: SkillCallRequest[] = [];
  collectSkillCalls(text, XML_SKILL_CALL_PATTERN, calls);
  collectSkillCalls(text, INLINE_SKILL_CALL_PATTERN, calls, (input) =>
    normalizeLegacyToolCallInput(input)
  );
  collectSkillCalls(text, LEGACY_TOOL_CALL_PATTERN, calls, (input) =>
    normalizeLegacyToolCallInput(input)
  );
  return calls;
}

export function stripSkillCalls(text: string): string {
  return text
    .replace(XML_SKILL_CALL_PATTERN, "")
    .replace(INLINE_SKILL_CALL_PATTERN, "")
    .replace(LEGACY_TOOL_CALL_PATTERN, "")
    .trim();
}

function collectSkillCalls(
  text: string,
  pattern: RegExp,
  calls: SkillCallRequest[],
  normalizeInput?: (input: string) => string
): void {
  for (const match of text.matchAll(pattern)) {
    const name = match[1]?.trim();
    const rawInput = match[2]?.trim() ?? "";
    const input = normalizeInput ? normalizeInput(rawInput) : rawInput;
    if (name) {
      calls.push({ skillName: name, input });
    }
  }
}

function normalizeLegacyToolCallInput(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return "";
  }

  const unwrappedString = unwrapLegacyQuotedString(trimmed);
  if (unwrappedString !== undefined) {
    return unwrappedString;
  }

  const parsedJson = tryParseJson(trimmed);
  if (parsedJson !== undefined) {
    return JSON.stringify(parsedJson);
  }

  const parsedLegacyValue = parseLegacyValue(trimmed);
  if (parsedLegacyValue !== undefined && parsedLegacyValue !== trimmed) {
    return typeof parsedLegacyValue === "string"
      ? parsedLegacyValue
      : JSON.stringify(parsedLegacyValue);
  }

  return trimmed;
}

function parseLegacyValue(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  const unwrappedString = unwrapLegacyQuotedString(trimmed);
  if (unwrappedString !== undefined) {
    return unwrappedString;
  }

  const parsedJson = tryParseJson(trimmed);
  if (parsedJson !== undefined) {
    return parsedJson;
  }

  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return parseLegacyObject(trimmed);
  }

  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return parseLegacyArray(trimmed);
  }

  if (trimmed === "true") {
    return true;
  }
  if (trimmed === "false") {
    return false;
  }
  if (trimmed === "null") {
    return null;
  }
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }

  return trimmed;
}

function parseLegacyObject(input: string): Record<string, unknown> | undefined {
  const body = input.slice(1, -1).trim();
  if (!body) {
    return {};
  }

  const result: Record<string, unknown> = {};
  for (const entry of splitLegacyTopLevel(body, ",")) {
    const separatorIndex = findLegacySeparatorIndex(entry, ":");
    if (separatorIndex < 0) {
      return undefined;
    }

    const rawKey = entry.slice(0, separatorIndex).trim();
    const rawValue = entry.slice(separatorIndex + 1).trim();
    if (!rawKey) {
      return undefined;
    }

    result[normalizeLegacyKey(rawKey)] = parseLegacyValue(rawValue);
  }
  return result;
}

function parseLegacyArray(input: string): unknown[] | undefined {
  const body = input.slice(1, -1).trim();
  if (!body) {
    return [];
  }

  return splitLegacyTopLevel(body, ",").map((entry) => parseLegacyValue(entry));
}

function normalizeLegacyKey(key: string): string {
  const trimmed = key.trim();
  const unwrappedString = unwrapLegacyQuotedString(trimmed);
  if (unwrappedString !== undefined) {
    return unwrappedString;
  }
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function unwrapLegacyQuotedString(value: string): string | undefined {
  if (
    value.startsWith(LEGACY_QUOTE_TOKEN) &&
    value.endsWith(LEGACY_QUOTE_TOKEN) &&
    value.length >= LEGACY_QUOTE_TOKEN.length * 2
  ) {
    return value.slice(
      LEGACY_QUOTE_TOKEN.length,
      value.length - LEGACY_QUOTE_TOKEN.length
    );
  }
  return undefined;
}

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function splitLegacyTopLevel(input: string, separator: string): string[] {
  const parts: string[] = [];
  let current = "";
  let curlyDepth = 0;
  let squareDepth = 0;
  let parenDepth = 0;
  let inDoubleQuotes = false;
  let inSingleQuotes = false;
  let inLegacyQuotes = false;

  for (let index = 0; index < input.length; index += 1) {
    if (input.startsWith(LEGACY_QUOTE_TOKEN, index)) {
      inLegacyQuotes = !inLegacyQuotes;
      current += LEGACY_QUOTE_TOKEN;
      index += LEGACY_QUOTE_TOKEN.length - 1;
      continue;
    }

    const character = input[index];
    if (!character) {
      continue;
    }

    const isEscaped = input[index - 1] === "\\";

    if (!inLegacyQuotes && !inSingleQuotes && character === '"' && !isEscaped) {
      inDoubleQuotes = !inDoubleQuotes;
      current += character;
      continue;
    }

    if (!inLegacyQuotes && !inDoubleQuotes && character === "'" && !isEscaped) {
      inSingleQuotes = !inSingleQuotes;
      current += character;
      continue;
    }

    if (!inLegacyQuotes && !inDoubleQuotes && !inSingleQuotes) {
      if (character === "{") {
        curlyDepth += 1;
      } else if (character === "}") {
        curlyDepth -= 1;
      } else if (character === "[") {
        squareDepth += 1;
      } else if (character === "]") {
        squareDepth -= 1;
      } else if (character === "(") {
        parenDepth += 1;
      } else if (character === ")") {
        parenDepth -= 1;
      } else if (
        character === separator &&
        curlyDepth === 0 &&
        squareDepth === 0 &&
        parenDepth === 0
      ) {
        parts.push(current.trim());
        current = "";
        continue;
      }
    }

    current += character;
  }

  if (current.trim()) {
    parts.push(current.trim());
  }

  return parts;
}

function findLegacySeparatorIndex(input: string, separator: string): number {
  let curlyDepth = 0;
  let squareDepth = 0;
  let parenDepth = 0;
  let inDoubleQuotes = false;
  let inSingleQuotes = false;
  let inLegacyQuotes = false;

  for (let index = 0; index < input.length; index += 1) {
    if (input.startsWith(LEGACY_QUOTE_TOKEN, index)) {
      inLegacyQuotes = !inLegacyQuotes;
      index += LEGACY_QUOTE_TOKEN.length - 1;
      continue;
    }

    const character = input[index];
    if (!character) {
      continue;
    }

    const isEscaped = input[index - 1] === "\\";

    if (!inLegacyQuotes && !inSingleQuotes && character === '"' && !isEscaped) {
      inDoubleQuotes = !inDoubleQuotes;
      continue;
    }

    if (!inLegacyQuotes && !inDoubleQuotes && character === "'" && !isEscaped) {
      inSingleQuotes = !inSingleQuotes;
      continue;
    }

    if (!inLegacyQuotes && !inDoubleQuotes && !inSingleQuotes) {
      if (character === "{") {
        curlyDepth += 1;
      } else if (character === "}") {
        curlyDepth -= 1;
      } else if (character === "[") {
        squareDepth += 1;
      } else if (character === "]") {
        squareDepth -= 1;
      } else if (character === "(") {
        parenDepth += 1;
      } else if (character === ")") {
        parenDepth -= 1;
      } else if (
        character === separator &&
        curlyDepth === 0 &&
        squareDepth === 0 &&
        parenDepth === 0
      ) {
        return index;
      }
    }
  }

  return -1;
}

export async function executeSkillScript(
  skill: LoadedSkillDocument,
  input: string,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<SkillCallResult> {
  if (!skill.hasScript || !skill.scriptPath) {
    return {
      skillName: skill.name,
      output: `Skill "${skill.name}" has no executable script.`,
      exitCode: 1,
    };
  }

  const scriptPath = skill.scriptPath;
  const scriptDir = path.dirname(scriptPath);
  const ext = path.extname(scriptPath).toLowerCase();

  const { command, args } = resolveInterpreter(scriptPath, ext);
  const structuredInput = buildStructuredSkillInput(input);
  const baseEnvironment = {
    ...process.env,
    SKILL_INPUT: input,
    SKILL_NAME: skill.name,
    ...structuredInput.env,
  };
  const firstResult = await runSkillProcess({
    command,
    args: [...args, ...structuredInput.args],
    cwd: scriptDir,
    env: baseEnvironment,
    stdin: input,
    skillName: skill.name,
    timeoutMs,
  });

  if (shouldRetryWithSinglePositionalArg(firstResult, structuredInput)) {
    const positionalInput = structuredInput.singleValuePositionalArg;
    if (positionalInput !== undefined) {
      const retriedResult = await runSkillProcess({
        command,
        args: [...args, positionalInput],
        cwd: scriptDir,
        env: baseEnvironment,
        stdin: input,
        skillName: skill.name,
        timeoutMs,
      });
      if (retriedResult.exitCode === 0) {
        return formatSkillProcessResult(skill.name, retriedResult);
      }
    }
  }

  return formatSkillProcessResult(skill.name, firstResult);
}

function resolveInterpreter(
  scriptPath: string,
  ext: string
): { command: string; args: string[] } {
  switch (ext) {
    case ".py":
      return { command: "python3", args: [scriptPath] };
    case ".js":
      return { command: "node", args: [scriptPath] };
    case ".ts":
      return { command: "npx", args: ["tsx", scriptPath] };
    case ".sh":
      return { command: "bash", args: [scriptPath] };
    default:
      return { command: scriptPath, args: [] };
  }
}

function buildStructuredSkillInput(input: string): {
  args: string[];
  env: Record<string, string>;
  singleValuePositionalArg?: string;
} {
  const trimmed = input.trim();
  if (!trimmed) {
    return { args: [], env: {} };
  }

  const cliArgs = parseCliInputArgs(trimmed);
  if (cliArgs.length > 0) {
    return { args: cliArgs, env: {} };
  }

  const parsed = tryParseJson(trimmed);
  if (!isJsonObject(parsed)) {
    return { args: [], env: {} };
  }

  const singleValuePositionalArg = extractSingleValuePositionalArg(parsed);
  return {
    args: buildCliArgsFromObject(parsed),
    env: {
      [SKILL_INPUT_JSON_ENV_KEY]: JSON.stringify(parsed),
    },
    ...(singleValuePositionalArg !== undefined
      ? { singleValuePositionalArg }
      : {}),
  };
}

function buildCliArgsFromObject(input: Record<string, unknown>): string[] {
  const args: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    appendCliArgsForValue(args, normalizeCliFlagName(key), value);
  }
  return args;
}

function appendCliArgsForValue(
  args: string[],
  flagName: string,
  value: unknown
): void {
  if (value === undefined || value === null || value === false) {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      appendCliArgsForValue(args, flagName, item);
    }
    return;
  }

  args.push(flagName);
  if (value === true) {
    return;
  }

  args.push(typeof value === "string" ? value : JSON.stringify(value));
}

function normalizeCliFlagName(key: string): string {
  const kebabCase = key
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/_/g, "-")
    .toLowerCase();
  return `--${kebabCase}`;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractSingleValuePositionalArg(
  value: Record<string, unknown>
): string | undefined {
  const entries = Object.entries(value).filter(
    ([, candidate]) => candidate !== undefined && candidate !== null
  );
  if (entries.length !== 1) {
    return undefined;
  }

  const entry = entries[0];
  if (!entry) {
    return undefined;
  }
  const [, candidate] = entry;
  if (typeof candidate === "string") {
    return candidate;
  }
  if (typeof candidate === "number" || typeof candidate === "boolean") {
    return String(candidate);
  }

  return undefined;
}

function parseCliInputArgs(input: string): string[] {
  if (!/(^|\s)--[A-Za-z0-9-]+/.test(input)) {
    return [];
  }

  const rawTokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (!character) {
      continue;
    }

    if (quote) {
      if (character === quote) {
        quote = undefined;
      } else if (
        character === "\\" &&
        index + 1 < input.length &&
        input[index + 1] === quote
      ) {
        current += quote;
        index += 1;
      } else {
        current += character;
      }
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }

    if (/\s/.test(character)) {
      if (current) {
        rawTokens.push(current);
        current = "";
      }
      continue;
    }

    current += character;
  }

  if (current) {
    rawTokens.push(current);
  }

  const normalizedTokens: string[] = [];
  for (let index = 0; index < rawTokens.length; index += 1) {
    const token = rawTokens[index];
    if (!token) {
      continue;
    }

    if (!isCliFlagToken(token)) {
      normalizedTokens.push(token);
      continue;
    }

    normalizedTokens.push(token);
    const valueTokens: string[] = [];
    while (
      index + 1 < rawTokens.length &&
      !isCliFlagToken(rawTokens[index + 1] ?? "")
    ) {
      const valueToken = rawTokens[index + 1];
      if (valueToken) {
        valueTokens.push(valueToken);
      }
      index += 1;
    }

    if (valueTokens.length > 0) {
      normalizedTokens.push(valueTokens.join(" "));
    }
  }

  return normalizedTokens;
}

function isCliFlagToken(token: string): boolean {
  return /^--[A-Za-z0-9-]+$/.test(token);
}

function shouldRetryWithSinglePositionalArg(
  result: Pick<SkillProcessResult, "stderr" | "exitCode" | "timedOut">,
  structuredInput: {
    args: string[];
    singleValuePositionalArg?: string;
  }
): boolean {
  return Boolean(
    structuredInput.args.length > 0 &&
      structuredInput.singleValuePositionalArg &&
      result.exitCode !== 0 &&
      !result.timedOut &&
      /unrecognized arguments:/i.test(result.stderr)
  );
}

interface SkillProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin: string;
  skillName: string;
  timeoutMs: number;
}

interface SkillProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  timeoutMs: number;
  errorMessage?: string;
}

async function runSkillProcess(
  options: SkillProcessOptions
): Promise<SkillProcessResult> {
  return new Promise<SkillProcessResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const resolveOnce = (result: SkillProcessResult) => {
      if (finished) {
        return;
      }
      finished = true;
      if (timer) {
        clearTimeout(timer);
      }
      resolve(result);
    };

    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.on("error", (error) => {
      if (isBrokenPipeError(error)) {
        return;
      }

      resolveOnce({
        stdout,
        stderr,
        exitCode: 1,
        timedOut: false,
        timeoutMs: options.timeoutMs,
        errorMessage: error.message,
      });
    });

    if (options.stdin.length > 0) {
      try {
        child.stdin.write(options.stdin);
      } catch (error) {
        if (!isBrokenPipeError(error)) {
          throw error;
        }
      }
    }

    try {
      child.stdin.end();
    } catch (error) {
      if (!isBrokenPipeError(error)) {
        throw error;
      }
    }

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT_BYTES) {
        stdout += chunk.toString();
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT_BYTES) {
        stderr += chunk.toString();
      }
    });

    timer = setTimeout(() => {
      if (!finished) {
        child.kill("SIGTERM");
        resolveOnce({
          stdout,
          stderr,
          exitCode: 124,
          timedOut: true,
          timeoutMs: options.timeoutMs,
        });
      }
    }, options.timeoutMs);

    child.on("close", (code) => {
      resolveOnce({
        stdout,
        stderr,
        exitCode: code ?? 1,
        timedOut: false,
        timeoutMs: options.timeoutMs,
      });
    });

    child.on("error", (error) => {
      resolveOnce({
        stdout,
        stderr,
        exitCode: 1,
        timedOut: false,
        timeoutMs: options.timeoutMs,
        errorMessage: error.message,
      });
    });
  });
}

function isBrokenPipeError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "EPIPE"
  );
}

function formatSkillProcessResult(
  skillName: string,
  result: SkillProcessResult
): SkillCallResult {
  if (result.errorMessage) {
    return {
      skillName,
      output: `Failed to execute skill "${skillName}": ${result.errorMessage}`,
      exitCode: 1,
    };
  }

  if (result.timedOut) {
    return {
      skillName,
      output:
        `Skill "${skillName}" timed out after ${result.timeoutMs}ms.\n${result.stdout}`.trim(),
      exitCode: 124,
    };
  }

  const output = result.stderr
    ? `${result.stdout}\n[stderr] ${result.stderr}`.trim()
    : result.stdout.trim();

  return {
    skillName,
    output: output || "(no output)",
    exitCode: result.exitCode,
  };
}

export const __testing = {
  buildCliArgsFromObject,
  buildExecutableSkillInstructions,
  buildSkillsPromptSections,
  buildToolPromptSections,
  buildStructuredSkillInput,
  extractSingleValuePositionalArg,
  normalizeCliFlagName,
  normalizeLegacyToolCallInput,
  parseCliInputArgs,
  parseSkillCalls,
  shouldRetryWithSinglePositionalArg,
  stripSkillCalls,
  resolveInterpreter,
};
