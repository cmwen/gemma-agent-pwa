import { afterEach, describe, expect, it, vi } from "vitest";
import { deleteSession, getSessions, restoreSession } from "./api";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("session API helpers", () => {
  it("requests the selected session list state", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("[]", {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      })
    );

    await getSessions("release-planner", "deleted");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/agents/release-planner/sessions?state=deleted"
    );
  });

  it("uses the delete mode query parameter for session removal", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));

    await deleteSession("release-planner", "session-1", "permanent");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/agents/release-planner/sessions/session-1?mode=permanent",
      { method: "DELETE" }
    );
  });

  it("posts to the restore endpoint", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));

    await restoreSession("release-planner", "session-1");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/agents/release-planner/sessions/session-1/restore",
      { method: "POST" }
    );
  });
});
