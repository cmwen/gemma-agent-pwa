import { mkdir, mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendCsv,
  buildApiBaseUrl,
  buildApiProxyTarget,
  DEFAULT_DEV_API_BASE_URL,
  findAvailablePort,
  resolvePort,
  resolveTestStoreRoot,
} from "../scripts/dev.js";

const servers: net.Server[] = [];
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        })
    )
  );
  servers.length = 0;
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true }))
  );
  delete process.env.MIN_KB_TEST_STORE_ROOT;
});

describe("dev launcher helpers", () => {
  it("builds the local API base URL from the selected API port", () => {
    expect(buildApiBaseUrl(8877)).toBe("http://127.0.0.1:8877/api");
  });

  it("keeps the dev client on the same-origin API path", () => {
    expect(DEFAULT_DEV_API_BASE_URL).toBe("/api");
  });

  it("builds the local API proxy target from the selected API port", () => {
    expect(buildApiProxyTarget(8877)).toBe("http://127.0.0.1:8877");
  });

  it("appends CSV values without duplicating origins", () => {
    expect(
      appendCsv("http://localhost:55006,http://127.0.0.1:55006", [
        "http://127.0.0.1:55006",
        "http://minipc-wsl:55006",
      ])
    ).toBe(
      "http://localhost:55006,http://127.0.0.1:55006,http://minipc-wsl:55006"
    );
  });

  it("moves to the next port when the preferred one is occupied", async () => {
    const server = await listenOnPort(0);
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected numeric server address.");
    }

    const nextPort = await findAvailablePort(address.port, 3);
    expect(nextPort).toBeGreaterThan(address.port);
    expect(nextPort).toBeLessThanOrEqual(address.port + 3);
  });

  it("keeps an explicit port override", async () => {
    await expect(resolvePort("55106", 55006)).resolves.toBe(55106);
  });

  it("discovers the repo-local test store fixture when present", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "gemma-agent-pwa-dev-"));
    tempRoots.push(root);
    await mkdir(path.join(root, "test/min-kb-store/agents"), {
      recursive: true,
    });

    expect(resolveTestStoreRoot(root)).toBe(
      path.join(root, "test/min-kb-store")
    );
  });

  it("prefers an explicit test store override", () => {
    process.env.MIN_KB_TEST_STORE_ROOT = "/tmp/custom-test-store";

    expect(resolveTestStoreRoot(process.cwd())).toBe("/tmp/custom-test-store");
  });
});

async function listenOnPort(port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(port, () => {
      servers.push(server);
      resolve(server);
    });
  });
}
