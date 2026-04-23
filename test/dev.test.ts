import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendCsv,
  buildApiBaseUrl,
  buildApiProxyTarget,
  buildWebOrigins,
  DEFAULT_DEV_API_BASE_URL,
  findAvailablePort,
  resolvePort,
} from "../scripts/dev.js";

const servers: net.Server[] = [];

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

  it("builds the local web origins used for API CORS", () => {
    expect(buildWebOrigins(55008)).toEqual([
      "http://localhost:55008",
      "http://127.0.0.1:55008",
      "http://minipc-wsl:55008",
      "http://minipc.local:55008",
    ]);
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
