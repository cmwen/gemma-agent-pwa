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
const defaultLocalHostnames = [
  "localhost",
  "127.0.0.1",
  "minipc-wsl",
  "minipc.local",
];

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
  const detectedDnsName = normalizeAllowedHost(tailscale?.Self?.DNSName);

  return dedupeStrings([
    ...getDetectedLocalHostnames(),
    detectedDnsName,
    getParentDomainAllowlistEntry(detectedDnsName),
    magicDnsSuffix ? `.${magicDnsSuffix}` : undefined,
    ...expandAllowedHosts(additionalHosts),
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
  expandAllowedHosts,
  getParentDomainAllowlistEntry,
  normalizeAllowedHost,
  normalizeHostname,
  resetTailscaleStatusCache,
  setTailscaleStatusForTests,
  toOrigin,
};

function getDetectedLocalHostnames(): string[] {
  return dedupeStrings([...defaultLocalHostnames, os.hostname()]);
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

function normalizeAllowedHost(value: string | undefined): string | undefined {
  const normalized = normalizeHostname(value);
  if (!normalized) {
    return undefined;
  }

  if (normalized.startsWith(".")) {
    return normalized;
  }

  const ip = normalized.replace(/^\[(.*)\]$/, "$1");
  if (isIP(ip)) {
    return ip;
  }

  const parsedUrl = parseHostLikeUrl(normalized);
  return normalizeHostname(parsedUrl?.hostname ?? normalized);
}

function expandAllowedHosts(values: string[]): string[] {
  return values.flatMap((value) => {
    const host = normalizeAllowedHost(value);
    if (!host) {
      return [];
    }

    return [host, getParentDomainAllowlistEntry(host)].filter(
      (entry): entry is string => Boolean(entry)
    );
  });
}

function getParentDomainAllowlistEntry(
  host: string | undefined
): string | undefined {
  if (!host || host.startsWith(".")) {
    return undefined;
  }

  const labels = host.split(".");
  if (labels.length < 3 || isIP(host)) {
    return undefined;
  }

  return `.${labels.slice(1).join(".")}`;
}

function parseHostLikeUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {}

  try {
    return new URL(`http://${value}`);
  } catch {
    return undefined;
  }
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
  const normalizedHost = isIP(host) === 6 ? `[${host}]` : host;
  if (port === 80) {
    return `http://${normalizedHost}`;
  }
  return `http://${normalizedHost}:${port}`;
}
