import { describe, expect, it } from "vitest";
import {
  isSessionPersistenceCancelledError,
  resolveWritableSession,
} from "./chat-session.js";

describe("resolveWritableSession", () => {
  it("ignores deleted sessions when deciding whether a request can resume", () => {
    expect(
      resolveWritableSession({
        sessionId: "session-1",
        agentId: "logseq",
        title: "Search my notes",
        startedAt: "2026-04-27T00:00:00.000Z",
        summary: "Pending summary.",
        manifestPath: "agents/logseq/history/2026-04/session-1/SESSION.md",
        turnCount: 1,
        deletedAt: "2026-04-27T00:05:00.000Z",
        turns: [],
      })
    ).toBeUndefined();
  });

  it("returns active sessions unchanged", () => {
    const session = {
      sessionId: "session-1",
      agentId: "logseq",
      title: "Search my notes",
      startedAt: "2026-04-27T00:00:00.000Z",
      summary: "Pending summary.",
      manifestPath: "agents/logseq/history/2026-04/session-1/SESSION.md",
      turnCount: 1,
      turns: [],
    };

    expect(resolveWritableSession(session)).toBe(session);
  });
});

describe("isSessionPersistenceCancelledError", () => {
  it("matches deleted and missing session persistence failures", () => {
    expect(
      isSessionPersistenceCancelledError(
        new Error("Cannot append turns to deleted session session-1")
      )
    ).toBe(true);
    expect(
      isSessionPersistenceCancelledError(
        new Error("Cannot record LLM stats for missing session session-1")
      )
    ).toBe(true);
    expect(
      isSessionPersistenceCancelledError(
        new Error("Session not found for agent logseq: session-1")
      )
    ).toBe(true);
  });

  it("does not hide unrelated failures", () => {
    expect(
      isSessionPersistenceCancelledError(
        new Error("Assistant turn was not persisted.")
      )
    ).toBe(false);
  });
});
