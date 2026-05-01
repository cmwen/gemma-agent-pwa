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

export function buildHttpOrigins(
  port: number,
  hosts: Array<string | undefined>
): string[] {
  return dedupeStrings(
    hosts.map((host) => (host ? toOrigin(host, port) : undefined)),
    normalizeOrigin
  );
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

export function getDetectedWebOriginsForPorts(
  ports: number[],
  additionalOrigins: string[] = []
): string[] {
  return dedupeStrings(
    [
      ...ports.flatMap((port) => getDetectedWebOrigins(port)),
      ...additionalOrigins,
    ],
    normalizeOrigin
  );
}

export const __testing = {
  dedupeStrings,
  expandAllowedHosts,
  getParentDomainAllowlistEntry,
  normalizeAllowedHost,
  normalizeOrigin,
  normalizeHostname,
  parseJsonObject,
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

  let rawStatus: string;
  try {
    rawStatus = childProcess.execFileSync("tailscale", ["status", "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (error) {
    cachedTailscaleStatus = null;
    if (
      error instanceof Error &&
      (error as NodeJS.ErrnoException).code !== "ENOENT"
    ) {
      const message =
        typeof (error as NodeJS.ErrnoException).code === "string"
          ? `${error.message} [${(error as NodeJS.ErrnoException).code}]`
          : error.message;
      console.warn(`[network] Failed to read Tailscale status: ${message}`);
    }
    return undefined;
  }

  const parsedStatus = parseJsonObject(rawStatus);
  if (!parsedStatus) {
    cachedTailscaleStatus = null;
    console.warn(
      "[network] Ignoring malformed tailscale status --json output."
    );
    return undefined;
  }

  cachedTailscaleStatus = parsedStatus as TailscaleStatus;
  return cachedTailscaleStatus;
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

function normalizeOrigin(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }

  const parsedUrl = parseHostLikeUrl(normalized);
  if (parsedUrl) {
    return parsedUrl.origin;
  }

  return normalized.replace(/\/+$/, "") || undefined;
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
  } catch (error) {
    if (!(error instanceof TypeError)) {
      throw error;
    }
  }

  try {
    return new URL(`http://${value}`);
  } catch (error) {
    if (!(error instanceof TypeError)) {
      throw error;
    }
    return undefined;
  }
}

function parseJsonObject(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return undefined;
  } catch (error) {
    if (error instanceof SyntaxError) {
      return undefined;
    }
    throw error;
  }
}

function dedupeStrings(
  values: Array<string | undefined>,
  normalizeValue: (
    value: string | undefined
  ) => string | undefined = normalizeHostname
): string[] {
  const deduped: string[] = [];
  for (const value of values) {
    const normalizedValue = normalizeValue(value);
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
