import { type ChildProcess, spawn } from "node:child_process";
import net from "node:net";
import { createInterface } from "node:readline";
import {
  buildHttpOrigins,
  getDetectedWebOrigins,
  splitCsv,
} from "./network.js";

export const DEFAULT_API_PORT = 8787;
export const DEFAULT_WEB_PORT = 55006;
export const DEFAULT_DEV_API_BASE_URL = "/api";
const DEFAULT_PORT_SCAN_LENGTH = 20;

async function main(): Promise<void> {
  const apiPort = await resolvePort(
    process.env.GEMMA_AGENT_PWA_PORT,
    DEFAULT_API_PORT
  );
  const webPort = await resolvePort(
    process.env.GEMMA_AGENT_PWA_WEB_PORT,
    DEFAULT_WEB_PORT
  );
  const apiServerUrl = buildApiBaseUrl(apiPort);
  const apiBaseUrl = process.env.VITE_API_BASE_URL ?? DEFAULT_DEV_API_BASE_URL;
  const apiProxyTarget =
    process.env.GEMMA_AGENT_PWA_API_PROXY_TARGET ??
    buildApiProxyTarget(apiPort);
  const webOrigins = getDetectedWebOrigins(webPort);

  console.info(
    [
      `[dev] Web URL: http://127.0.0.1:${webPort}`,
      `[dev] API URL: ${apiServerUrl}`,
      `[dev] Client API base: ${apiBaseUrl}`,
      `[dev] Dev API proxy: ${apiProxyTarget}`,
    ].join("\n")
  );

  const apiChild = spawnPnpm(
    ["--filter", "@gemma-agent-pwa/api", "dev"],
    {
      ...process.env,
      GEMMA_AGENT_PWA_PORT: String(apiPort),
      GEMMA_AGENT_PWA_CORS_ORIGINS: appendCsv(
        process.env.GEMMA_AGENT_PWA_CORS_ORIGINS,
        webOrigins
      ),
    },
    "api"
  );
  const webChild = spawnPnpm(
    ["--filter", "@gemma-agent-pwa/web", "dev", "--", "--strictPort"],
    {
      ...process.env,
      GEMMA_AGENT_PWA_WEB_PORT: String(webPort),
      VITE_API_BASE_URL: apiBaseUrl,
      GEMMA_AGENT_PWA_API_PROXY_TARGET: apiProxyTarget,
    },
    "web"
  );

  await waitForChildren([apiChild, webChild]);
}

export async function resolvePort(
  preferredPort: string | undefined,
  fallbackPort: number
): Promise<number> {
  const requestedPort = parsePort(preferredPort);
  if (requestedPort !== undefined) {
    return requestedPort;
  }

  return findAvailablePort(fallbackPort, DEFAULT_PORT_SCAN_LENGTH);
}

export async function findAvailablePort(
  startPort: number,
  count: number
): Promise<number> {
  for (let port = startPort; port < startPort + count; port += 1) {
    if (await canListenOnPort(port)) {
      return port;
    }
  }
  return getEphemeralPort();
}

export function buildApiBaseUrl(apiPort: number): string {
  return `http://127.0.0.1:${apiPort}/api`;
}

export function buildApiProxyTarget(apiPort: number): string {
  return `http://127.0.0.1:${apiPort}`;
}

export function buildWebOrigins(webPort: number): string[] {
  return buildHttpOrigins(webPort, [
    "localhost",
    "127.0.0.1",
    "minipc-wsl",
    "minipc.local",
  ]);
}

export function appendCsv(
  existingValue: string | undefined,
  additions: string[]
): string {
  return [...splitCsv(existingValue), ...additions]
    .filter((value, index, values) => values.indexOf(value) === index)
    .join(",");
}

function parsePort(value: string | undefined): number | undefined {
  if (!value?.trim()) {
    return undefined;
  }

  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`Invalid port value: ${value}`);
  }
  return port;
}

async function canListenOnPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
  });
}

async function getEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() =>
          reject(new Error("Failed to resolve ephemeral port."))
        );
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

function spawnPnpm(
  args: string[],
  env: NodeJS.ProcessEnv,
  name: string
): ChildProcess {
  const child = spawn("pnpm", args, {
    env,
    stdio: ["inherit", "pipe", "pipe"],
  });
  pipeOutput(child.stdout, name);
  pipeOutput(child.stderr, name);
  return child;
}

async function waitForChildren(children: ChildProcess[]): Promise<void> {
  let settled = false;
  const stopChildren = (signal: NodeJS.Signals = "SIGTERM") => {
    for (const child of children) {
      if (!child.killed && child.exitCode === null) {
        child.kill(signal);
      }
    }
  };

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      stopChildren(signal);
    });
  }

  await new Promise<void>((resolve, reject) => {
    for (const child of children) {
      child.once("exit", (code, signal) => {
        if (settled) {
          return;
        }
        settled = true;
        stopChildren(signal ?? "SIGTERM");
        if (signal) {
          reject(new Error(`Dev process exited from ${signal}.`));
          return;
        }
        if (code && code !== 0) {
          reject(new Error(`Dev process exited with code ${code}.`));
          return;
        }
        resolve();
      });
      child.once("error", (error) => {
        if (settled) {
          return;
        }
        settled = true;
        stopChildren();
        reject(error);
      });
    }
  });
}

function pipeOutput(stream: NodeJS.ReadableStream | null, name: string): void {
  if (!stream) {
    return;
  }

  const reader = createInterface({ input: stream });
  reader.on("line", (line) => {
    process.stdout.write(`[${name}] ${line}\n`);
  });
}

if (
  process.argv[1] &&
  import.meta.url === new URL(process.argv[1], "file://").href
) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
