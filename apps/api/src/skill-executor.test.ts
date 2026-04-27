import { describe, expect, it } from "vitest";
import { __testing, parseSkillCalls, stripSkillCalls } from "./agent-skills.js";

const {
  buildExecutableSkillInstructions,
  buildSkillsPromptSections,
  buildCliArgsFromObject,
  buildStructuredSkillInput,
  extractSingleValuePositionalArg,
  normalizeCliFlagName,
  normalizeLegacyToolCallInput,
  resolveInterpreter,
  shouldRetryWithSinglePositionalArg,
} = __testing;

describe("parseSkillCalls", () => {
  it("extracts a single skill call from LLM output", () => {
    const text = `Let me look that up for you.

<skill_call name="web-search">latest TypeScript release</skill_call>

I'll get back to you shortly.`;

    const calls = parseSkillCalls(text);
    expect(calls).toEqual([
      { skillName: "web-search", input: "latest TypeScript release" },
    ]);
  });

  it("extracts multiple skill calls", () => {
    const text = `I need two things:

<skill_call name="read-file">package.json</skill_call>

And also:

<skill_call name="run-test">npm test</skill_call>`;

    const calls = parseSkillCalls(text);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({
      skillName: "read-file",
      input: "package.json",
    });
    expect(calls[1]).toEqual({ skillName: "run-test", input: "npm test" });
  });

  it("extracts legacy agent-skills tool calls", () => {
    const text = `I'll check that.

<|tool_call>call:load-context{"topic":"gut-health"}<|tool_call|>`;

    const calls = parseSkillCalls(text);
    expect(calls).toEqual([
      { skillName: "load-context", input: '{"topic":"gut-health"}' },
    ]);
  });

  it("extracts malformed legacy agent-skills tool calls from thinking mode", () => {
    const text = `<|tool_call>call:capture-wellness-note{body:<|"|>Running 2 to 3 times per week for approximately 40 minutes each session. Goal is to maintain a high metabolic rate.<|"|>,tag:exercise,topic:routine}<tool_call|>`;

    const calls = parseSkillCalls(text);
    expect(calls).toEqual([
      {
        skillName: "capture-wellness-note",
        input:
          '{"body":"Running 2 to 3 times per week for approximately 40 minutes each session. Goal is to maintain a high metabolic rate.","tag":"exercise","topic":"routine"}',
      },
    ]);
  });

  it("returns empty array when no skill calls present", () => {
    const text = "Just a normal response with no tool calls.";
    expect(parseSkillCalls(text)).toEqual([]);
  });

  it("handles multiline input in skill call", () => {
    const text = `<skill_call name="write-code">function hello() {
  console.log("world");
}</skill_call>`;

    const calls = parseSkillCalls(text);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toContain('console.log("world")');
  });

  it("handles empty input in skill call", () => {
    const text = '<skill_call name="status"></skill_call>';
    const calls = parseSkillCalls(text);
    expect(calls).toEqual([{ skillName: "status", input: "" }]);
  });
});

describe("stripSkillCalls", () => {
  it("removes skill call blocks from text", () => {
    const text = `Before the call.

<skill_call name="test">input</skill_call>

After the call.`;

    const stripped = stripSkillCalls(text);
    expect(stripped).toBe("Before the call.\n\n\n\nAfter the call.");
  });

  it("returns original text when no skill calls present", () => {
    const text = "No skill calls here.";
    expect(stripSkillCalls(text)).toBe("No skill calls here.");
  });

  it("strips multiple skill calls", () => {
    const text = `<skill_call name="a">1</skill_call> and <skill_call name="b">2</skill_call>`;
    const stripped = stripSkillCalls(text);
    expect(stripped).toBe("and");
  });

  it("strips legacy agent-skills tool calls", () => {
    const text = `Before

<|tool_call>call:load-context{}<|tool_call|>

After`;

    expect(stripSkillCalls(text)).toBe("Before\n\n\n\nAfter");
  });

  it("strips malformed legacy agent-skills tool calls", () => {
    const text = `Before

<|tool_call>call:load-context{}<tool_call|>

After`;

    expect(stripSkillCalls(text)).toBe("Before\n\n\n\nAfter");
  });
});

describe("normalizeLegacyToolCallInput", () => {
  it("converts legacy key-value objects into JSON", () => {
    const input =
      '{body:<|"|>Metabolism-focused running routine.<|"|>,tag:exercise,priority:1,enabled:true}';

    expect(normalizeLegacyToolCallInput(input)).toBe(
      '{"body":"Metabolism-focused running routine.","tag":"exercise","priority":1,"enabled":true}'
    );
  });

  it("unwraps legacy quoted strings", () => {
    expect(normalizeLegacyToolCallInput('<|"|>plain text<|"|>')).toBe(
      "plain text"
    );
  });
});

describe("structured skill input helpers", () => {
  it("normalizes argument keys to kebab-case CLI flags", () => {
    expect(normalizeCliFlagName("ensureParent")).toBe("--ensure-parent");
    expect(normalizeCliFlagName("with_text")).toBe("--with-text");
    expect(normalizeCliFlagName("date")).toBe("--date");
  });

  it("converts JSON object input into CLI arguments", () => {
    expect(
      buildCliArgsFromObject({
        date: "today",
        text: "Today is a holiday.",
        ensureParent: true,
        tags: ["holiday", "journal"],
        draft: false,
      })
    ).toEqual([
      "--date",
      "today",
      "--text",
      "Today is a holiday.",
      "--ensure-parent",
      "--tags",
      "holiday",
      "--tags",
      "journal",
    ]);
  });

  it("only builds structured input metadata for JSON objects", () => {
    expect(buildStructuredSkillInput("plain text")).toEqual({
      args: [],
      env: {},
    });
    expect(
      buildStructuredSkillInput('{"date":"today","text":"Today is a holiday."}')
    ).toEqual({
      args: ["--date", "today", "--text", "Today is a holiday."],
      env: {
        SKILL_INPUT_JSON: '{"date":"today","text":"Today is a holiday."}',
      },
    });
  });

  it("extracts a fallback positional argument from single-field JSON objects", () => {
    expect(extractSingleValuePositionalArg({ query: "TODO" })).toBe("TODO");
    expect(extractSingleValuePositionalArg({ count: 3 })).toBe("3");
    expect(
      extractSingleValuePositionalArg({ query: "TODO", scope: "all" })
    ).toBe(undefined);
    expect(extractSingleValuePositionalArg({ query: ["TODO"] })).toBe(
      undefined
    );
  });

  it("retries single-field JSON input as a positional argument after argparse-style flag errors", () => {
    expect(
      shouldRetryWithSinglePositionalArg(
        {
          stdout: "",
          stderr: "error: unrecognized arguments: --query\n",
          exitCode: 2,
          timedOut: false,
        },
        {
          args: ["--query", "TODO"],
          singleValuePositionalArg: "TODO",
        }
      )
    ).toBe(true);

    expect(
      shouldRetryWithSinglePositionalArg(
        {
          stdout: "",
          stderr: "Error: missing graph root",
          exitCode: 1,
          timedOut: false,
        },
        {
          args: ["--query", "TODO"],
          singleValuePositionalArg: "TODO",
        }
      )
    ).toBe(false);
  });
});

describe("resolveInterpreter", () => {
  it("uses bash for .sh files", () => {
    const result = resolveInterpreter("/path/run.sh", ".sh");
    expect(result).toEqual({ command: "bash", args: ["/path/run.sh"] });
  });

  it("uses python3 for .py files", () => {
    const result = resolveInterpreter("/path/run.py", ".py");
    expect(result).toEqual({ command: "python3", args: ["/path/run.py"] });
  });

  it("uses node for .js files", () => {
    const result = resolveInterpreter("/path/run.js", ".js");
    expect(result).toEqual({ command: "node", args: ["/path/run.js"] });
  });

  it("uses npx tsx for .ts files", () => {
    const result = resolveInterpreter("/path/run.ts", ".ts");
    expect(result).toEqual({ command: "npx", args: ["tsx", "/path/run.ts"] });
  });

  it("uses direct execution for unknown extensions", () => {
    const result = resolveInterpreter("/path/run", "");
    expect(result).toEqual({ command: "/path/run", args: [] });
  });
});

describe("executeSkillScript", () => {
  it("returns error for skills without scripts", async () => {
    const { executeSkillScript } = await import("./agent-skills.js");
    const skill = {
      name: "no-script",
      description: "A skill without a script",
      scope: "agent-local" as const,
      path: "/fake/SKILL.md",
      sourceRoot: "/fake",
      hasScript: false,
      content: "No script here.",
    };

    const result = await executeSkillScript(skill, "test input");
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("no executable script");
  });
});

describe("skill prompt building", () => {
  it("uses markdown body guidance instead of descriptor metadata", () => {
    const skill = {
      name: "release-notes",
      description: "Hidden frontmatter description.",
      scope: "agent-local" as const,
      path: "/fake/SKILL.md",
      sourceRoot: "/fake",
      hasScript: true,
      scriptPath: "/fake/run.sh",
      content: [
        "Use this skill to draft release notes from shipped changes.",
        'Prefer JSON input like {"version":"1.2.3"} when the release number is known.',
      ].join("\n\n"),
    };

    const sections = buildSkillsPromptSections([skill]);
    const instructions = buildExecutableSkillInstructions([skill]);

    expect(sections).toContain("Use this skill to draft release notes");
    expect(sections).toContain("Prefer JSON input");
    expect(sections).not.toContain("Hidden frontmatter description.");
    expect(sections).not.toContain("Scope:");
    expect(instructions).toContain("release-notes");
    expect(instructions).toContain("Use this skill to draft release notes");
    expect(instructions).not.toContain("Hidden frontmatter description.");
    expect(instructions).toContain(
      "When a skill needs a single free-form or positional input"
    );
  });
});
