import { spawn } from "node:child_process";
import path from "node:path";
import type { LoadedSkillDocument } from "@gemma-agent-pwa/min-kb-bridge";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 64_000;

export interface SkillCallRequest {
  skillName: string;
  input: string;
}

export interface SkillCallResult {
  skillName: string;
  output: string;
  exitCode: number;
}

const SKILL_CALL_PATTERN =
  /<skill_call\s+name="([^"]+)">([\s\S]*?)<\/skill_call>/g;

export function parseSkillCalls(text: string): SkillCallRequest[] {
  const calls: SkillCallRequest[] = [];
  for (const match of text.matchAll(SKILL_CALL_PATTERN)) {
    const name = match[1]?.trim();
    const input = match[2]?.trim() ?? "";
    if (name) {
      calls.push({ skillName: name, input });
    }
  }
  return calls;
}

export function stripSkillCalls(text: string): string {
  return text.replace(SKILL_CALL_PATTERN, "").trim();
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

  return new Promise<SkillCallResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let finished = false;

    const child = spawn(command, args, {
      cwd: scriptDir,
      env: {
        ...process.env,
        SKILL_INPUT: input,
        SKILL_NAME: skill.name,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    child.stdin.write(input);
    child.stdin.end();

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

    const timer = setTimeout(() => {
      if (!finished) {
        finished = true;
        child.kill("SIGTERM");
        resolve({
          skillName: skill.name,
          output:
            `Skill "${skill.name}" timed out after ${timeoutMs}ms.\n${stdout}`.trim(),
          exitCode: 124,
        });
      }
    }, timeoutMs);

    child.on("close", (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      const output = stderr
        ? `${stdout}\n[stderr] ${stderr}`.trim()
        : stdout.trim();
      resolve({
        skillName: skill.name,
        output: output || "(no output)",
        exitCode: code ?? 1,
      });
    });

    child.on("error", (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({
        skillName: skill.name,
        output: `Failed to execute skill "${skill.name}": ${error.message}`,
        exitCode: 1,
      });
    });
  });
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

export const __testing = {
  parseSkillCalls,
  stripSkillCalls,
  resolveInterpreter,
};
