import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import { getDetectedAllowedHosts, splitCsv } from "../../scripts/network.js";

const basePath = normalizeBasePath(process.env.VITE_BASE_PATH);
const apiBaseUrl = process.env.VITE_API_BASE_URL;
const apiUrl = parseAbsoluteUrl(apiBaseUrl);
const webPort = Number(process.env.GEMMA_AGENT_PWA_WEB_PORT ?? 55006);
const apiProxyTarget =
  process.env.GEMMA_AGENT_PWA_API_PROXY_TARGET ??
  apiUrl?.origin ??
  "http://localhost:8787";
const apiPathPrefix = `${trimTrailingSlash(apiUrl?.pathname ?? "")}/api/`;
const apiRuntimeCachePattern = apiUrl
  ? new RegExp(`^${escapeRegExp(apiUrl.origin)}${escapeRegExp(apiPathPrefix)}`)
  : /\/api\//;
const allowedHosts = [
  ...getDetectedAllowedHosts(
    splitCsv(process.env.GEMMA_AGENT_PWA_ALLOWED_HOSTS)
  ),
];

export default defineConfig({
  base: basePath,
  plugins: [
    react(),
    VitePWA({
      registerType: "prompt",
      includeAssets: ["favicon.svg"],
      manifest: {
        name: "Gemma Agent PWA",
        short_name: "Gemma Agent",
        description: "Local-first Gemma 4 chat for min-kb-store agents.",
        theme_color: "#101828",
        background_color: "#101828",
        display: "standalone",
        start_url: basePath,
        scope: basePath,
        icons: [
          {
            src: `${basePath}favicon.svg`,
            sizes: "any",
            type: "image/svg+xml",
            purpose: "any maskable",
          },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,ico}"],
        runtimeCaching: [
          {
            urlPattern: apiRuntimeCachePattern,
            handler: "NetworkFirst",
            options: {
              cacheName: "api-cache",
              networkTimeoutSeconds: 2,
            },
          },
        ],
      },
    }),
  ],
  server: {
    host: "0.0.0.0",
    port: webPort,
    allowedHosts,
    proxy: {
      "/api": {
        target: apiProxyTarget,
        changeOrigin: true,
      },
    },
  },
});

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function normalizeBasePath(value = "/"): string {
  if (!value.trim()) {
    return "/";
  }

  const withLeadingSlash = value.startsWith("/") ? value : `/${value}`;
  return withLeadingSlash.endsWith("/")
    ? withLeadingSlash
    : `${withLeadingSlash}/`;
}

function parseAbsoluteUrl(value: string | undefined): URL | undefined {
  if (!value) {
    return undefined;
  }

  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
