import * as childProcess from "node:child_process";
import { isIP } from "node:net";
import os from "node:os";

interface TailscaleStatus {
  Self?: {
    DNSName?: string;
    TailscaleIPs?: string[];
  };
  MagicDNSSuffix?: string;
}

let cachedTailscaleStatus: TailscaleStatus | null | undefined;

export function splitCsv(value = ""): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function buildHttpOrigins(port: number, hosts: string[]): string[] {
  return dedupeStrings(hosts.map((host) => toOrigin(host, port)));
}

export function getDetectedAllowedHosts(
  additionalHosts: string[] = []
): string[] {
  const tailscale = getTailscaleStatus();
  const magicDnsSuffix = normalizeHostname(tailscale?.MagicDNSSuffix);

  return dedupeStrings([
    ...getDetectedLocalHostnames(),
    normalizeHostname(tailscale?.Self?.DNSName),
    magicDnsSuffix ? `.${magicDnsSuffix}` : undefined,
    ...additionalHosts,
  ]);
}

export function getDetectedWebOrigins(
  port: number,
  additionalHosts: string[] = []
): string[] {
  const tailscale = getTailscaleStatus();

  return buildHttpOrigins(port, [
    ...getDetectedLocalHostnames(),
    normalizeHostname(tailscale?.Self?.DNSName),
    ...(tailscale?.Self?.TailscaleIPs ?? []),
    ...additionalHosts,
  ]);
}

export const __testing = {
  dedupeStrings,
  normalizeHostname,
  resetTailscaleStatusCache,
  setTailscaleStatusForTests,
  toOrigin,
};

function getDetectedLocalHostnames(): string[] {
  return dedupeStrings(["localhost", "127.0.0.1", "minipc-wsl", os.hostname()]);
}

function getTailscaleStatus(): TailscaleStatus | undefined {
  if (cachedTailscaleStatus !== undefined) {
    return cachedTailscaleStatus ?? undefined;
  }

  try {
    const rawStatus = childProcess.execFileSync(
      "tailscale",
      ["status", "--json"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }
    );
    cachedTailscaleStatus = JSON.parse(rawStatus) as TailscaleStatus;
    return cachedTailscaleStatus;
  } catch {
    cachedTailscaleStatus = null;
    return undefined;
  }
}

function resetTailscaleStatusCache(): void {
  cachedTailscaleStatus = undefined;
}

function setTailscaleStatusForTests(status: TailscaleStatus | undefined): void {
  cachedTailscaleStatus = status ?? null;
}

function normalizeHostname(value: string | undefined): string | undefined {
  const normalized = value?.trim().replace(/\.$/, "").toLowerCase();
  return normalized ? normalized : undefined;
}

function dedupeStrings(values: Array<string | undefined>): string[] {
  const deduped: string[] = [];
  for (const value of values) {
    const normalizedValue = normalizeHostname(value);
    if (!normalizedValue || deduped.includes(normalizedValue)) {
      continue;
    }
    deduped.push(normalizedValue);
  }
  return deduped;
}

function toOrigin(host: string, port: number): string {
  return `http://${isIP(host) === 6 ? `[${host}]` : host}:${port}`;
}
