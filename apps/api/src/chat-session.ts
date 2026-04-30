import type { ChatSession } from "@gemma-agent-pwa/contracts";

export function resolveWritableSession(
  session: ChatSession | undefined
): ChatSession | undefined {
  if (!session || session.deletedAt) {
    return undefined;
  }

  return session;
}

export function isSessionPersistenceCancelledError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return /deleted session|session not found|missing session/i.test(
    error.message
  );
}
