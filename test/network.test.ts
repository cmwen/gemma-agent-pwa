import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __testing,
  getDetectedAllowedHosts,
  getDetectedWebOrigins,
} from "../scripts/network.js";

afterEach(() => {
  vi.restoreAllMocks();
  __testing.resetTailscaleStatusCache();
});

describe("network helpers", () => {
  it("adds the Tailscale MagicDNS suffix to the allowed Vite hosts", () => {
    vi.spyOn(os, "hostname").mockReturnValue("minipc");
    __testing.setTailscaleStatusForTests({
      Self: {
        DNSName: "minipc-wsl.tail2e322f.ts.net.",
        TailscaleIPs: ["100.118.5.8"],
      },
      MagicDNSSuffix: "tail2e322f.ts.net",
    });

    expect(getDetectedAllowedHosts(["custom-host"])).toEqual([
      "localhost",
      "127.0.0.1",
      "minipc-wsl",
      "minipc.local",
      "minipc",
      "minipc-wsl.tail2e322f.ts.net",
      ".tail2e322f.ts.net",
      "custom-host",
    ]);
  });

  it("adds the Tailscale DNS name and IP to detected web origins", () => {
    vi.spyOn(os, "hostname").mockReturnValue("minipc");
    __testing.setTailscaleStatusForTests({
      Self: {
        DNSName: "minipc-wsl.tail2e322f.ts.net.",
        TailscaleIPs: ["100.118.5.8", "fd7a:115c:a1e0::9f38:508"],
      },
      MagicDNSSuffix: "tail2e322f.ts.net",
    });

    expect(getDetectedWebOrigins(55008)).toEqual([
      "http://localhost:55008",
      "http://127.0.0.1:55008",
      "http://minipc-wsl:55008",
      "http://minipc.local:55008",
      "http://minipc:55008",
      "http://minipc-wsl.tail2e322f.ts.net:55008",
      "http://100.118.5.8:55008",
      "http://[fd7a:115c:a1e0::9f38:508]:55008",
    ]);
  });

  it("omits the default HTTP port when building browser origins", () => {
    expect(getDetectedWebOrigins(80)).toContain("http://minipc.local");
  });
});
