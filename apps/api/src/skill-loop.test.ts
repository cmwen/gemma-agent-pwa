import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDelegationTool } from "@gemma-agent-pwa/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeSkillScript, parseSkillCalls } from "./agent-skills.js";
import { __testing as chatLoopTesting, runChatLoop } from "./chat-loop.js";
import { __testing as lmstudioTesting } from "./lmstudio.js";

const {
  DEFAULT_MAX_SKILL_LOOP_ITERATIONS,
  FINALIZE_AFTER_SKILLS_INSTRUCTION,
  MAX_ORCHESTRATOR_SKILL_LOOP_ITERATIONS,
} = chatLoopTesting;
const { buildSystemPrompt } = lmstudioTesting;

describe("agentic skill loop", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "skill-test-"));
  });

  it("executes non-delegation tools through the shared runtime tool path", async () => {
    const executeToolCall = vi.fn().mockResolvedValueOnce({
      skillName: "load-skill",
      output:
        'Loaded skill "release-notes".\nExecutable: yes.\nScope: agent-local.\n\nUse this skill to draft release notes.',
      exitCode: 0,
    });
    const streamChat = vi
      .fn()
      .mockResolvedValueOnce({
        assistantText:
          '<skill_call name="load-skill">{"skillName":"release-notes"}</skill_call>',
        llmStats: {
          recordedAt: "2026-05-14T00:00:00.000Z",
          model: "google/gemma-4b-it",
          requestCount: 1,
          inputTokens: 12,
          outputTokens: 4,
          durationMs: 90,
        },
      })
      .mockResolvedValueOnce({
        assistantText: "I loaded the release-notes skill and can use it now.",
        llmStats: {
          recordedAt: "2026-05-14T00:00:01.000Z",
          model: "google/gemma-4b-it",
          requestCount: 1,
          inputTokens: 18,
          outputTokens: 10,
          durationMs: 120,
        },
      });

    const result = await runChatLoop({
      agentId: "release-planner",
      agentPrompt: "Be helpful.",
      config: {
        provider: "lmstudio",
        model: "google/gemma-4b-it",
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
          createdAt: "2026-05-14T00:00:00.000Z",
          bodyMarkdown: "Figure out how to use the release notes skill.",
          relativePath: "in-flight",
        },
      ],
      enabledSkills: [
        {
          name: "release-notes",
          description: "Draft release notes",
          scope: "agent-local",
          path: "agents/release-planner/skills/release-notes/SKILL.md",
          sourceRoot: "agents/release-planner/skills",
          hasScript: true,
          scriptPath: "agents/release-planner/skills/release-notes/run.sh",
          content: "Use this skill to draft release notes.",
        },
      ],
      tools: [
        {
          name: "load-skill",
          description:
            "Load the full SKILL.md instructions for one enabled skill.",
          parameters: {
            type: "object",
          },
          metadata: {
            kind: "skill-loader",
          },
        },
      ],
      sessionId: "session-load-skill",
      streamChat,
      executeToolCall,
    });

    expect(executeToolCall).toHaveBeenCalledWith({
      skillName: "load-skill",
      input: '{"skillName":"release-notes"}',
    });
    expect(result.assistantText).toBe(
      "I loaded the release-notes skill and can use it now."
    );
    expect(result.conversationTurns).toEqual([
      expect.objectContaining({
        sender: "user",
        bodyMarkdown: "Figure out how to use the release notes skill.",
      }),
      expect.objectContaining({
        sender: "tool",
        bodyMarkdown: expect.stringContaining('Loaded skill "release-notes".'),
      }),
      expect.objectContaining({
        sender: "system",
        bodyMarkdown: FINALIZE_AFTER_SKILLS_INSTRUCTION,
      }),
    ]);
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

  it("ignores broken-pipe stdin errors when a skill closes stdin early", async () => {
    const scriptPath = path.join(tmpDir, "run.sh");
    await fs.writeFile(
      scriptPath,
      ["#!/bin/bash", "exec 0<&-", "sleep 0.05", 'echo "stdin closed"'].join(
        "\n"
      ),
      { mode: 0o755 }
    );

    const skill = {
      name: "close-stdin",
      description: "Closes stdin immediately",
      scope: "agent-local" as const,
      path: path.join(tmpDir, "SKILL.md"),
      sourceRoot: tmpDir,
      hasScript: true,
      scriptPath,
      content: "Closes stdin immediately.",
    };

    const result = await executeSkillScript(skill, "ignored input");

    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("stdin closed");
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

  it("passes unquoted multi-word CLI flag values as a single argument", async () => {
    const scriptPath = path.join(tmpDir, "run.py");
    await fs.writeFile(
      scriptPath,
      [
        "import argparse",
        "",
        "parser = argparse.ArgumentParser()",
        'parser.add_argument("--type", required=True)',
        'parser.add_argument("--title", required=True)',
        'parser.add_argument("--body", required=True)',
        "args = parser.parse_args()",
        'print(f"type={args.type}|title={args.title}|body={args.body}")',
      ].join("\n"),
      { mode: 0o755 }
    );

    const skill = {
      name: "memory-capture",
      description: "Captures memory",
      scope: "agent-local" as const,
      path: path.join(tmpDir, "SKILL.md"),
      sourceRoot: tmpDir,
      hasScript: true,
      scriptPath,
      content: "Captures working memory.",
    };

    const result = await executeSkillScript(
      skill,
      '--type working --title Soccer Star Origin Story Plan --body "Goal: write the story."'
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).toBe(
      "type=working|title=Soccer Star Origin Story Plan|body=Goal: write the story."
    );
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
  it("returns the first LM Studio reply unchanged when no skill call is emitted", async () => {
    const streamChat = vi.fn().mockImplementation(async (input) => {
      input.onSnapshot({
        assistantText: "Release checklist ready.",
        thinkingText: "Checking the saved milestones before answering.",
      });
      return {
        assistantText: "Release checklist ready.",
        thinkingText: "Checking the saved milestones before answering.",
        llmStats: {
          recordedAt: "2026-05-07T00:00:00.000Z",
          model: "google/gemma-4b-it",
          requestCount: 1,
          inputTokens: 32,
          outputTokens: 7,
          durationMs: 180,
        },
      };
    });
    const emitEvent = vi.fn();

    const result = await runChatLoop({
      agentId: "release-planner",
      agentPrompt: "Be helpful.",
      config: {
        provider: "lmstudio",
        model: "google/gemma-4b-it",
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
          createdAt: "2026-05-07T00:00:00.000Z",
          bodyMarkdown: "Outline the release checklist.",
          relativePath: "in-flight",
        },
      ],
      enabledSkills: [],
      sessionId: "session-golden",
      emitEvent,
      streamChat,
    });

    expect(result).toMatchObject({
      assistantText: "Release checklist ready.",
      thinkingText: "Checking the saved milestones before answering.",
      llmStats: {
        requestCount: 1,
        inputTokens: 32,
        outputTokens: 7,
        durationMs: 180,
      },
    });
    expect(result.conversationTurns).toEqual([
      expect.objectContaining({
        sender: "user",
        bodyMarkdown: "Outline the release checklist.",
      }),
    ]);
    expect(streamChat).toHaveBeenCalledTimes(1);
    expect(streamChat).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          provider: "lmstudio",
          model: "google/gemma-4b-it",
        }),
        conversation: [
          expect.objectContaining({
            sender: "user",
            bodyMarkdown: "Outline the release checklist.",
          }),
        ],
      })
    );
    expect(emitEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "skill_call" })
    );
    expect(emitEvent).toHaveBeenCalledWith({
      type: "assistant_snapshot",
      assistantText: "Release checklist ready.",
      thinkingText: "Checking the saved milestones before answering.",
    });
  });

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
      skillCallId: "skill-call-1-calculator",
      skillName: "calculator",
      skillInput: '{"expression":"2+2"}',
    });
    expect(emitEvent).toHaveBeenCalledWith({
      type: "skill_result",
      skillCallId: "skill-call-1-calculator",
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

  it("waits for the delegation tool result before finalizing", async () => {
    const streamChat = vi
      .fn()
      .mockResolvedValueOnce({
        assistantText:
          '<skill_call name="delegate-task">{"agentId":"qa-tasker","prompt":"Check the release checklist."}</skill_call>',
        llmStats: {
          recordedAt: "2026-04-27T00:00:00.000Z",
          model: "google/gemma-3-4b",
          requestCount: 1,
          inputTokens: 11,
          outputTokens: 4,
          durationMs: 100,
        },
      })
      .mockResolvedValueOnce({
        assistantText: "Delegation complete.",
        llmStats: {
          recordedAt: "2026-04-27T00:00:00.000Z",
          model: "google/gemma-3-4b",
          requestCount: 1,
          inputTokens: 15,
          outputTokens: 5,
          durationMs: 110,
        },
      });
    const executeToolCall = vi.fn().mockResolvedValue({
      skillName: "delegate-task",
      output: "Delegated to qa-tasker.",
      exitCode: 0,
    });

    const result = await runChatLoop({
      agentId: "release-orchestrator",
      agentPrompt: "Coordinate the release.",
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
          bodyMarkdown: "Please delegate the QA check.",
          relativePath: "in-flight",
        },
      ],
      enabledSkills: [],
      tools: [
        (() => {
          const delegationTool = createDelegationTool({
            agentTitle: "Release Orchestrator",
            delegatedAgentIds: ["qa-tasker"],
          });
          if (!delegationTool) {
            throw new Error("Expected delegation tool.");
          }
          return delegationTool;
        })(),
      ],
      sessionId: "session-delegation",
      streamChat,
      executeToolCall,
    });

    expect(result.assistantText).toBe("Delegation complete.");
    expect(executeToolCall).toHaveBeenCalledWith({
      skillName: "delegate-task",
      input: '{"agentId":"qa-tasker","prompt":"Check the release checklist."}',
    });
    expect(result.conversationTurns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sender: "tool",
          bodyMarkdown: expect.stringContaining("Delegated to qa-tasker."),
        }),
      ])
    );
    expect(streamChat).toHaveBeenCalledTimes(2);
  });

  it("falls back to the latest tool result when LM Studio omits the final assistant text", async () => {
    const streamChat = vi
      .fn()
      .mockResolvedValueOnce({
        assistantText:
          '<skill_call name="delegate-task">{"agentId":"qa-tasker","prompt":"Check the release checklist."}</skill_call>',
        llmStats: {
          recordedAt: "2026-04-27T00:00:00.000Z",
          model: "google/gemma-3-4b",
          requestCount: 1,
          inputTokens: 11,
          outputTokens: 4,
          durationMs: 100,
        },
      })
      .mockResolvedValueOnce({
        assistantText: "",
        llmStats: {
          recordedAt: "2026-04-27T00:00:00.000Z",
          model: "google/gemma-3-4b",
          requestCount: 1,
          inputTokens: 15,
          outputTokens: 0,
          durationMs: 110,
        },
      });
    const executeToolCall = vi.fn().mockResolvedValue({
      skillName: "delegate-task",
      output: "Delegated to qa-tasker.\n\nSummary: Checklist verified.",
      exitCode: 0,
    });

    const result = await runChatLoop({
      agentId: "release-orchestrator",
      agentPrompt: "Coordinate the release.",
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
          bodyMarkdown: "Please delegate the QA check.",
          relativePath: "in-flight",
        },
      ],
      enabledSkills: [],
      tools: [
        (() => {
          const delegationTool = createDelegationTool({
            agentTitle: "Release Orchestrator",
            delegatedAgentIds: ["qa-tasker"],
          });
          if (!delegationTool) {
            throw new Error("Expected delegation tool.");
          }
          return delegationTool;
        })(),
      ],
      sessionId: "session-delegation-fallback",
      streamChat,
      executeToolCall,
    });

    expect(result.assistantText).toBe(
      "Delegated to qa-tasker.\n\nSummary: Checklist verified."
    );
    expect(streamChat).toHaveBeenCalledTimes(2);
  });

  it("executes inline Gemma delegation tool calls with non-English prompts", async () => {
    const streamChat = vi
      .fn()
      .mockResolvedValueOnce({
        assistantText:
          'skill_call:delegate-task{agentId:<|"|>writer<|"|>,prompt:<|"|>請用繁體中文撰寫一篇關於 Oby 成為世界知名足球員的小說。<|"|>}',
        llmStats: {
          recordedAt: "2026-04-27T00:00:00.000Z",
          model: "google/gemma-4-e2b",
          requestCount: 1,
          inputTokens: 12,
          outputTokens: 5,
          durationMs: 100,
        },
      })
      .mockResolvedValueOnce({
        assistantText: "已委派給 writer。",
        llmStats: {
          recordedAt: "2026-04-27T00:00:00.000Z",
          model: "google/gemma-4-e2b",
          requestCount: 1,
          inputTokens: 14,
          outputTokens: 4,
          durationMs: 110,
        },
      });
    const executeToolCall = vi.fn().mockResolvedValue({
      skillName: "delegate-task",
      output: "Delegated to writer.",
      exitCode: 0,
    });

    const result = await runChatLoop({
      agentId: "fiction-generator",
      agentKind: "orchestrator",
      agentPrompt: "Delegate story writing when needed.",
      config: {
        provider: "lmstudio",
        model: "google/gemma-4-e2b",
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
          bodyMarkdown: "請呼叫 writer agent。",
          relativePath: "in-flight",
        },
      ],
      enabledSkills: [],
      tools: [
        (() => {
          const delegationTool = createDelegationTool({
            agentTitle: "Fiction Generator",
            delegatedAgentIds: ["writer"],
          });
          if (!delegationTool) {
            throw new Error("Expected delegation tool.");
          }
          return delegationTool;
        })(),
      ],
      sessionId: "session-inline-delegation",
      streamChat,
      executeToolCall,
    });

    expect(result.assistantText).toBe("已委派給 writer。");
    expect(executeToolCall).toHaveBeenCalledWith({
      skillName: "delegate-task",
      input:
        '{"agentId":"writer","prompt":"請用繁體中文撰寫一篇關於 Oby 成為世界知名足球員的小說。"}',
    });
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

  it("continues across multiple skill iterations before finalizing", async () => {
    const streamChat = vi
      .fn()
      .mockResolvedValueOnce({
        assistantText:
          '<skill_call name="search-store">release checklist</skill_call>',
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
        assistantText:
          '<skill_call name="read-file">docs/release-notes.md</skill_call>',
        llmStats: {
          recordedAt: "2026-04-27T00:00:00.000Z",
          model: "google/gemma-3-4b",
          requestCount: 1,
          inputTokens: 12,
          outputTokens: 4,
          durationMs: 110,
        },
      })
      .mockResolvedValueOnce({
        assistantText: "The release notes are ready.",
        llmStats: {
          recordedAt: "2026-04-27T00:00:00.000Z",
          model: "google/gemma-3-4b",
          requestCount: 1,
          inputTokens: 14,
          outputTokens: 5,
          durationMs: 120,
        },
      });
    const executeSkill = vi
      .fn()
      .mockImplementation(async (skill: { name: string }, input: string) => ({
        skillName: skill.name,
        output:
          skill.name === "search-store"
            ? `Found file for ${input}`
            : `Contents of ${input}`,
        exitCode: 0,
      }));

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
          bodyMarkdown: "Prepare the release notes.",
          relativePath: "in-flight",
        },
      ],
      enabledSkills: [
        {
          name: "search-store",
          description: "Searches notes.",
          scope: "agent-local",
          path: "/fake/SKILL.md",
          sourceRoot: "/fake",
          hasScript: true,
          scriptPath: "/fake/run.sh",
          content: "Use this skill to search stored notes.",
        },
        {
          name: "read-file",
          description: "Reads files.",
          scope: "agent-local",
          path: "/fake/SKILL.md",
          sourceRoot: "/fake",
          hasScript: true,
          scriptPath: "/fake/run.sh",
          content: "Use this skill to read files.",
        },
      ],
      sessionId: "session-multi",
      streamChat,
      executeSkill,
    });

    expect(result.assistantText).toBe("The release notes are ready.");
    expect(result.llmStats.requestCount).toBe(3);
    expect(executeSkill).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ name: "search-store" }),
      "release checklist"
    );
    expect(executeSkill).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ name: "read-file" }),
      "docs/release-notes.md"
    );
    expect(result.conversationTurns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sender: "system",
          bodyMarkdown: FINALIZE_AFTER_SKILLS_INSTRUCTION,
        }),
      ])
    );
    expect(streamChat).toHaveBeenCalledTimes(3);
  });

  it("allows orchestrators to continue beyond the default skill loop budget", async () => {
    const streamChat = vi.fn();
    for (
      let iteration = 0;
      iteration < DEFAULT_MAX_SKILL_LOOP_ITERATIONS + 1;
      iteration += 1
    ) {
      streamChat.mockResolvedValueOnce({
        assistantText: '<skill_call name="search-store">next task</skill_call>',
        llmStats: {
          recordedAt: "2026-04-27T00:00:00.000Z",
          model: "google/gemma-3-4b",
          requestCount: 1,
          inputTokens: 10,
          outputTokens: 4,
          durationMs: 100,
        },
      });
    }
    streamChat.mockResolvedValueOnce({
      assistantText: "Orchestration complete.",
      llmStats: {
        recordedAt: "2026-04-27T00:00:00.000Z",
        model: "google/gemma-3-4b",
        requestCount: 1,
        inputTokens: 10,
        outputTokens: 4,
        durationMs: 100,
      },
    });
    const executeSkill = vi.fn().mockResolvedValue({
      skillName: "search-store",
      output: "Completed delegated step.",
      exitCode: 0,
    });

    const result = await runChatLoop({
      agentId: "fiction-generator",
      agentKind: "orchestrator",
      agentPrompt: "Coordinate the writing run.",
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
          bodyMarkdown: "Run the full fiction workflow.",
          relativePath: "in-flight",
        },
      ],
      enabledSkills: [
        {
          name: "search-store",
          description: "Searches notes.",
          scope: "agent-local",
          path: "/fake/SKILL.md",
          sourceRoot: "/fake",
          hasScript: true,
          scriptPath: "/fake/run.sh",
          content: "Use this skill to search stored notes.",
        },
      ],
      sessionId: "session-orchestrator",
      streamChat,
      executeSkill,
    });

    expect(result.assistantText).toBe("Orchestration complete.");
    expect(streamChat).toHaveBeenCalledTimes(
      DEFAULT_MAX_SKILL_LOOP_ITERATIONS + 2
    );
    expect(executeSkill).toHaveBeenCalledTimes(
      DEFAULT_MAX_SKILL_LOOP_ITERATIONS + 1
    );
    expect(MAX_ORCHESTRATOR_SKILL_LOOP_ITERATIONS).toBeGreaterThan(
      DEFAULT_MAX_SKILL_LOOP_ITERATIONS
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
      'When a skill needs named inputs like type, title, body, path, or agentId, prefer a JSON object body such as {"type":"working","title":"Run plan"}.'
    );
    expect(prompt).toContain(
      "If the result is sufficient, answer the user directly in plain language."
    );
    expect(prompt).toContain(
      "If you still need another executable skill, emit the next skill_call block(s) only."
    );
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
