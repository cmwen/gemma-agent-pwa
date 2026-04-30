import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeSkillScript, parseSkillCalls } from "./agent-skills.js";
import { runChatLoop } from "./chat-loop.js";
import { __testing } from "./lmstudio.js";

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

  it("maps JSON object input to CLI flags for legacy skill scripts", async () => {
    const scriptPath = path.join(tmpDir, "run.sh");
    await fs.writeFile(
      scriptPath,
      [
        "#!/bin/bash",
        'while [[ "$#" -gt 0 ]]; do',
        '  case "$1" in',
        '    --date) DATE="$2"; shift 2 ;;',
        '    --text) TEXT="$2"; shift 2 ;;',
        '    --ensure-parent) ENSURE_PARENT="yes"; shift ;;',
        '    *) echo "Unexpected arg: $1"; exit 1 ;;',
        "  esac",
        "done",
        'echo "date=$DATE|text=$TEXT|ensure=$ENSURE_PARENT"',
      ].join("\n"),
      { mode: 0o755 }
    );

    const skill = {
      name: "write-journal",
      description: "Writes a journal entry",
      scope: "agent-local" as const,
      path: path.join(tmpDir, "SKILL.md"),
      sourceRoot: tmpDir,
      hasScript: true,
      scriptPath,
      content: "Writes a journal entry.",
    };

    const result = await executeSkillScript(
      skill,
      '{"date":"today","text":"Today is a holiday.","ensure-parent":true}'
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).toBe(
      "date=today|text=Today is a holiday.|ensure=yes"
    );
  });

  it("retries single-field JSON input as a positional argument for argparse-style skills", async () => {
    const scriptPath = path.join(tmpDir, "run.py");
    await fs.writeFile(
      scriptPath,
      [
        "import argparse",
        "",
        "parser = argparse.ArgumentParser()",
        'parser.add_argument("query")',
        'parser.add_argument("--scope", default="all")',
        "args = parser.parse_args()",
        'print(f"query={args.query}|scope={args.scope}")',
      ].join("\n"),
      { mode: 0o755 }
    );

    const skill = {
      name: "search-store",
      description: "Searches the store",
      scope: "agent-local" as const,
      path: path.join(tmpDir, "SKILL.md"),
      sourceRoot: tmpDir,
      hasScript: true,
      scriptPath,
      content: "Searches the store.",
    };

    const result = await executeSkillScript(skill, '{"query":"TODO"}');

    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("query=TODO|scope=all");
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

describe("runChatLoop", () => {
  it("executes requested skills and feeds the result back into the next iteration", async () => {
    const streamChat = vi
      .fn()
      .mockResolvedValueOnce({
        assistantText:
          '<skill_call name="calculator">{"expression":"2+2"}</skill_call>',
        llmStats: {
          recordedAt: "2026-04-27T00:00:00.000Z",
          model: "google/gemma-3-4b",
          requestCount: 1,
          inputTokens: 10,
          outputTokens: 4,
          durationMs: 100,
        },
      })
      .mockResolvedValueOnce({
        assistantText: "The answer is 4.",
        thinkingText: "Validated with the calculator skill.",
        llmStats: {
          recordedAt: "2026-04-27T00:00:00.000Z",
          model: "google/gemma-3-4b",
          requestCount: 1,
          inputTokens: 8,
          outputTokens: 5,
          durationMs: 120,
        },
      });
    const executeSkill = vi.fn().mockResolvedValue({
      skillName: "calculator",
      output: "4",
      exitCode: 0,
    });
    const emitEvent = vi.fn();

    const result = await runChatLoop({
      agentId: "release-planner",
      agentPrompt: "Be helpful.",
      config: {
        provider: "lmstudio",
        model: "google/gemma-3-4b",
        presetId: "gemma4-balanced",
        lmStudioEnableThinking: true,
        maxCompletionTokens: 4096,
        contextWindowSize: 32768,
        temperature: 0.2,
        topP: 0.95,
        disabledSkills: [],
      },
      conversationTurns: [
        {
          messageId: "turn-1",
          sender: "user",
          createdAt: "2026-04-27T00:00:00.000Z",
          bodyMarkdown: "What is 2+2?",
          relativePath: "in-flight",
        },
      ],
      enabledSkills: [
        {
          name: "calculator",
          description: "Calculates answers.",
          scope: "agent-local",
          path: "/fake/SKILL.md",
          sourceRoot: "/fake",
          hasScript: true,
          scriptPath: "/fake/run.sh",
          content: "Use this skill for calculations.",
        },
      ],
      sessionId: "session-123",
      emitEvent,
      streamChat,
      executeSkill,
    });

    expect(result.assistantText).toBe("The answer is 4.");
    expect(result.thinkingText).toBe("Validated with the calculator skill.");
    expect(result.llmStats.requestCount).toBe(2);
    expect(result.llmStats.inputTokens).toBe(18);
    expect(result.llmStats.outputTokens).toBe(9);
    expect(result.conversationTurns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sender: "tool",
          bodyMarkdown: expect.stringContaining("Skill result: calculator"),
        }),
      ])
    );
    expect(executeSkill).toHaveBeenCalledWith(
      expect.objectContaining({ name: "calculator" }),
      '{"expression":"2+2"}'
    );
    expect(emitEvent).toHaveBeenCalledWith({
      type: "skill_call",
      skillName: "calculator",
      skillInput: '{"expression":"2+2"}',
    });
    expect(emitEvent).toHaveBeenCalledWith({
      type: "skill_result",
      skillName: "calculator",
      skillOutput: "4",
      exitCode: 0,
    });
  });

  it("surfaces an unavailable skill and still finalizes on the next pass", async () => {
    const streamChat = vi
      .fn()
      .mockResolvedValueOnce({
        assistantText: '<skill_call name="missing-skill">input</skill_call>',
        llmStats: {
          recordedAt: "2026-04-27T00:00:00.000Z",
          model: "google/gemma-3-4b",
          requestCount: 1,
          inputTokens: 10,
          outputTokens: 3,
          durationMs: 50,
        },
      })
      .mockResolvedValueOnce({
        assistantText: "I could not use that skill.",
        llmStats: {
          recordedAt: "2026-04-27T00:00:00.000Z",
          model: "google/gemma-3-4b",
          requestCount: 1,
          inputTokens: 12,
          outputTokens: 4,
          durationMs: 50,
        },
      });

    const result = await runChatLoop({
      agentId: "release-planner",
      agentPrompt: "Be helpful.",
      config: {
        provider: "lmstudio",
        model: "google/gemma-3-4b",
        presetId: "gemma4-balanced",
        lmStudioEnableThinking: true,
        maxCompletionTokens: 4096,
        contextWindowSize: 32768,
        temperature: 0.2,
        topP: 0.95,
        disabledSkills: [],
      },
      conversationTurns: [],
      enabledSkills: [],
      sessionId: "session-456",
      streamChat,
    });

    expect(result.assistantText).toBe("I could not use that skill.");
    expect(result.conversationTurns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sender: "tool",
          bodyMarkdown: expect.stringContaining(
            'Skill "missing-skill" is not available or has no executable script.'
          ),
        }),
      ])
    );
  });

  it("executes legacy split tool calls emitted by Gemma-style outputs", async () => {
    const streamChat = vi
      .fn()
      .mockResolvedValueOnce({
        assistantText:
          '<|tool_call>call\nsearch-store{query: "TODO"}<tool_call|>',
        llmStats: {
          recordedAt: "2026-04-27T00:00:00.000Z",
          model: "google/gemma-4-e4b",
          requestCount: 1,
          inputTokens: 10,
          outputTokens: 4,
          durationMs: 100,
        },
      })
      .mockResolvedValueOnce({
        assistantText: "Here are the TODO notes.",
        llmStats: {
          recordedAt: "2026-04-27T00:00:00.000Z",
          model: "google/gemma-4-e4b",
          requestCount: 1,
          inputTokens: 12,
          outputTokens: 5,
          durationMs: 110,
        },
      });
    const executeSkill = vi.fn().mockResolvedValue({
      skillName: "search-store",
      output: "TODO 1\nTODO 2",
      exitCode: 0,
    });

    const result = await runChatLoop({
      agentId: "logseq",
      agentPrompt: "Be helpful.",
      config: {
        provider: "lmstudio",
        model: "google/gemma-4-e4b",
        presetId: "gemma4-balanced",
        lmStudioEnableThinking: true,
        maxCompletionTokens: 4096,
        contextWindowSize: 32768,
        temperature: 0.2,
        topP: 0.95,
        disabledSkills: [],
      },
      conversationTurns: [
        {
          messageId: "turn-1",
          sender: "user",
          createdAt: "2026-04-27T00:00:00.000Z",
          bodyMarkdown: "search my logseq for TODOs",
          relativePath: "in-flight",
        },
      ],
      enabledSkills: [
        {
          name: "search-store",
          description: "Searches the store.",
          scope: "agent-local",
          path: "/fake/SKILL.md",
          sourceRoot: "/fake",
          hasScript: true,
          scriptPath: "/fake/run.py",
          content: "Use this skill for searching.",
        },
      ],
      sessionId: "session-789",
      streamChat,
      executeSkill,
    });

    expect(result.assistantText).toBe("Here are the TODO notes.");
    expect(executeSkill).toHaveBeenCalledWith(
      expect.objectContaining({ name: "search-store" }),
      '{"query":"TODO"}'
    );
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
        content:
          'A calculator skill.\n\nUse a JSON object like {"expression":"2+2"} when you need named arguments.',
      },
    ];

    const prompt = buildSystemPrompt("Be helpful.", skills);
    expect(prompt).toContain("Skill execution");
    expect(prompt).toContain("skill_call");
    expect(prompt).toContain("calculator");
    expect(prompt).toContain("Executable");
    expect(prompt).toContain("respond with skill_call block(s) only");
    expect(prompt).toContain("call it directly instead of asking a follow-up");
    expect(prompt).toContain(
      "single free-form or positional input such as a search query"
    );
    expect(prompt).toContain(
      "Use a JSON object only when you need named flags or multiple named arguments."
    );
    expect(prompt).toContain("answer the user directly in plain language");
    expect(prompt).toContain(
      'Use a JSON object like {"expression":"2+2"} when you need named arguments.'
    );
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
    expect(prompt).toContain(
      "Reference-only in this runtime. Do not call it as a tool."
    );
  });

  it("returns undefined when no agent prompt and no skills", () => {
    const prompt = buildSystemPrompt(undefined, []);
    // Should still have the base instruction
    expect(prompt).toContain("LM Studio");
  });
});
