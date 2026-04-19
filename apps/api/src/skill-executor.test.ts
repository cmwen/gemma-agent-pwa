import { describe, expect, it } from "vitest";
import {
  __testing,
  parseSkillCalls,
  stripSkillCalls,
} from "./skill-executor.js";

const { resolveInterpreter } = __testing;

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
    const { executeSkillScript } = await import("./skill-executor.js");
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
