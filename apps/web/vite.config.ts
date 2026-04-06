import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

const basePath = normalizeBasePath(process.env.VITE_BASE_PATH);
const apiBaseUrl = process.env.VITE_API_BASE_URL;
const apiUrl = apiBaseUrl ? new URL(apiBaseUrl) : undefined;
const apiPathPrefix = `${trimTrailingSlash(apiUrl?.pathname ?? "")}/api/`;
const apiRuntimeCachePattern = apiUrl
  ? new RegExp(`^${escapeRegExp(apiUrl.origin)}${escapeRegExp(apiPathPrefix)}`)
  : /\/api\//;

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
    port: 4173,
    proxy: {
      "/api": {
        target: "http://localhost:8787",
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
