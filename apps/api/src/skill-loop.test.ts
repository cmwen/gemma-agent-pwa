import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __testing } from "./lmstudio.js";
import { executeSkillScript, parseSkillCalls } from "./skill-executor.js";

const { buildSystemPrompt } = __testing;

describe("agentic skill loop", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "skill-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("executes a bash skill script and returns output", async () => {
    const scriptPath = path.join(tmpDir, "run.sh");
    await fs.writeFile(scriptPath, '#!/bin/bash\necho "Hello from skill"', {
      mode: 0o755,
    });

    const skill = {
      name: "greeting",
      description: "Says hello",
      scope: "agent-local" as const,
      path: path.join(tmpDir, "SKILL.md"),
      sourceRoot: tmpDir,
      hasScript: true,
      scriptPath,
      content: "A greeting skill.",
    };

    const result = await executeSkillScript(skill, "");
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("Hello from skill");
    expect(result.skillName).toBe("greeting");
  });

  it("passes input via stdin to skill script", async () => {
    const scriptPath = path.join(tmpDir, "run.sh");
    await fs.writeFile(
      scriptPath,
      '#!/bin/bash\nread -r INPUT\necho "Got: $INPUT"',
      { mode: 0o755 }
    );

    const skill = {
      name: "echo-skill",
      description: "Echoes input",
      scope: "agent-local" as const,
      path: path.join(tmpDir, "SKILL.md"),
      sourceRoot: tmpDir,
      hasScript: true,
      scriptPath,
      content: "Echoes input back.",
    };

    const result = await executeSkillScript(skill, "test data");
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("Got: test data");
  });

  it("sets SKILL_INPUT env var for skill scripts", async () => {
    const scriptPath = path.join(tmpDir, "run.sh");
    await fs.writeFile(scriptPath, '#!/bin/bash\necho "ENV: $SKILL_INPUT"', {
      mode: 0o755,
    });

    const skill = {
      name: "env-skill",
      description: "Reads env var",
      scope: "agent-local" as const,
      path: path.join(tmpDir, "SKILL.md"),
      sourceRoot: tmpDir,
      hasScript: true,
      scriptPath,
      content: "Reads environment variable.",
    };

    const result = await executeSkillScript(skill, "env value");
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("ENV: env value");
  });

  it("captures non-zero exit codes", async () => {
    const scriptPath = path.join(tmpDir, "run.sh");
    await fs.writeFile(scriptPath, '#!/bin/bash\necho "failing"\nexit 42', {
      mode: 0o755,
    });

    const skill = {
      name: "fail-skill",
      description: "Fails deliberately",
      scope: "agent-local" as const,
      path: path.join(tmpDir, "SKILL.md"),
      sourceRoot: tmpDir,
      hasScript: true,
      scriptPath,
      content: "Fails on purpose.",
    };

    const result = await executeSkillScript(skill, "");
    expect(result.exitCode).toBe(42);
    expect(result.output).toBe("failing");
  });

  it("handles script timeout gracefully", async () => {
    const scriptPath = path.join(tmpDir, "run.sh");
    await fs.writeFile(scriptPath, "#!/bin/bash\nsleep 60", { mode: 0o755 });

    const skill = {
      name: "slow-skill",
      description: "Takes too long",
      scope: "agent-local" as const,
      path: path.join(tmpDir, "SKILL.md"),
      sourceRoot: tmpDir,
      hasScript: true,
      scriptPath,
      content: "A slow skill.",
    };

    const result = await executeSkillScript(skill, "", 500);
    expect(result.exitCode).toBe(124);
    expect(result.output).toContain("timed out");
  });

  it("parses skill calls from simulated LLM output and round-trips execution", async () => {
    const scriptPath = path.join(tmpDir, "run.sh");
    await fs.writeFile(
      scriptPath,
      '#!/bin/bash\nread -r Q\necho "Answer to: $Q"',
      { mode: 0o755 }
    );

    const skill = {
      name: "qa-skill",
      description: "Q&A skill",
      scope: "agent-local" as const,
      path: path.join(tmpDir, "SKILL.md"),
      sourceRoot: tmpDir,
      hasScript: true,
      scriptPath,
      content: "Answers questions.",
    };

    const llmOutput = `Let me check that for you.

<skill_call name="qa-skill">What is 2+2?</skill_call>

I'll have the answer soon.`;

    const calls = parseSkillCalls(llmOutput);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.skillName).toBe("qa-skill");

    const firstCall = calls[0];
    if (!firstCall) throw new Error("Expected at least one skill call");
    const result = await executeSkillScript(skill, firstCall.input);
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("Answer to: What is 2+2?");
  });
});

describe("system prompt with executable skills", () => {
  it("includes skill execution instructions when executable skills are present", () => {
    const skills = [
      {
        name: "calculator",
        description: "Does math",
        scope: "agent-local" as const,
        path: "/fake/SKILL.md",
        sourceRoot: "/fake",
        hasScript: true,
        scriptPath: "/fake/run.sh",
        content: "A calculator skill.",
      },
    ];

    const prompt = buildSystemPrompt("Be helpful.", skills);
    expect(prompt).toContain("Skill execution");
    expect(prompt).toContain("skill_call");
    expect(prompt).toContain("calculator");
    expect(prompt).toContain("Executable");
  });

  it("does not include execution instructions when no executable skills", () => {
    const skills = [
      {
        name: "knowledge",
        description: "Just context",
        scope: "agent-local" as const,
        path: "/fake/SKILL.md",
        sourceRoot: "/fake",
        hasScript: false,
        content: "Reference material.",
      },
    ];

    const prompt = buildSystemPrompt("Be helpful.", skills);
    expect(prompt).not.toContain("skill_call");
    expect(prompt).toContain("knowledge");
  });

  it("returns undefined when no agent prompt and no skills", () => {
    const prompt = buildSystemPrompt(undefined, []);
    // Should still have the base instruction
    expect(prompt).toContain("LM Studio");
  });
});
