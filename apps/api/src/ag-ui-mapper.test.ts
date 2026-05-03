import { EventType } from "@ag-ui/core";
import { describe, expect, it, vi } from "vitest";
import { __testing, createAgUiEventMapper } from "./ag-ui-mapper.js";

describe("createAgUiEventMapper", () => {
  it("sanitizes raw skill-call markup from assistant snapshots before emitting AG-UI text", async () => {
    const emitEvent = vi.fn().mockResolvedValue(undefined);
    const mapper = createAgUiEventMapper({
      emitEvent,
      runId: "run-1",
      threadId: "thread-1",
    });

    await mapper.apply({
      type: "assistant_snapshot",
      assistantText:
        'Before<skill_call name="release-checklist">{"scope":"mobile"}',
    });

    expect(emitEvent).toHaveBeenNthCalledWith(1, {
      type: EventType.TEXT_MESSAGE_START,
      messageId: expect.stringMatching(/^assistant-/),
      role: "assistant",
    });
    expect(emitEvent).toHaveBeenNthCalledWith(2, {
      type: EventType.TEXT_MESSAGE_CONTENT,
      delta: "Before",
      messageId: expect.stringMatching(/^assistant-/),
    });
  });

  it("preserves skill call ids across AG-UI tool call events", async () => {
    const emitEvent = vi.fn().mockResolvedValue(undefined);
    const mapper = createAgUiEventMapper({
      emitEvent,
      runId: "run-1",
      threadId: "thread-1",
    });

    await mapper.apply({
      type: "skill_call",
      skillCallId: "skill-call-1-release-checklist",
      skillInput: '{"scope":"mobile"}',
      skillName: "release-checklist",
    });
    await mapper.apply({
      type: "skill_result",
      skillCallId: "skill-call-1-release-checklist",
      exitCode: 0,
      skillName: "release-checklist",
      skillOutput: "Checklist drafted for mobile release.",
    });

    expect(emitEvent).toHaveBeenNthCalledWith(1, {
      type: EventType.TOOL_CALL_START,
      toolCallId: "skill-call-1-release-checklist",
      toolCallName: "release-checklist",
    });
    expect(emitEvent).toHaveBeenNthCalledWith(2, {
      type: EventType.TOOL_CALL_ARGS,
      delta: '{"scope":"mobile"}',
      toolCallId: "skill-call-1-release-checklist",
    });
    expect(emitEvent).toHaveBeenNthCalledWith(3, {
      type: EventType.TOOL_CALL_END,
      toolCallId: "skill-call-1-release-checklist",
    });
    expect(emitEvent).toHaveBeenNthCalledWith(4, {
      type: EventType.CUSTOM,
      name: "gemma-skill-result",
      value: {
        exitCode: 0,
        toolCallId: "skill-call-1-release-checklist",
      },
    });
    expect(emitEvent).toHaveBeenNthCalledWith(5, {
      type: EventType.TOOL_CALL_RESULT,
      content: "Checklist drafted for mobile release.",
      messageId: expect.stringMatching(/^tool-result-/),
      toolCallId: "skill-call-1-release-checklist",
    });
  });
});

describe("sanitizeVisibleAssistantText", () => {
  it("strips complete and partial skill call markup", () => {
    expect(
      __testing.sanitizeVisibleAssistantText(
        'Before<skill_call name="release-checklist">{"scope":"mobile"}</skill_call>After'
      )
    ).toBe("BeforeAfter");
    expect(
      __testing.sanitizeVisibleAssistantText(
        '<|tool_call>call:release-checklist{"scope":"mobile"}<tool_call|>'
      )
    ).toBe("");
  });
});
