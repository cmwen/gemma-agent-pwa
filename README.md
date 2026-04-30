# Gemma Agent PWA

Local-first chat PWA for `min-kb-store` agents, optimized for LM Studio with Gemma models and fast thinking-mode switching.

## What it includes

- React + Vite PWA frontend
- Hono local API runtime
- `min-kb-store` bridge for agent discovery and Markdown chat history
- LM Studio OpenAI-compatible streaming chat integration
- Gemma presets for **Fast**, **Balanced**, and **Deep**
- Separate persistence for visible assistant output and captured thinking metadata

## Workspace layout

```text
apps/
  api/   Local API for min-kb-store access and LM Studio chat
  web/   Responsive PWA UI
packages/
  contracts/      Shared Zod schemas and runtime presets
  min-kb-bridge/  Filesystem adapter for min-kb-store
```

## Requirements

- Node 22+
- pnpm 10+
- LM Studio running locally with its OpenAI-compatible server enabled
- A `min-kb-store` checkout

## Environment

Set the Markdown store root before running the API:

```bash
export MIN_KB_STORE_ROOT=/absolute/path/to/min-kb-store
```

Optional LM Studio overrides:

```bash
export LM_STUDIO_BASE_URL=http://127.0.0.1:1234/v1
export LM_STUDIO_MODEL=google/gemma-3-4b
```

When `LM_STUDIO_BASE_URL` is unset, the API now tries `127.0.0.1`, `localhost`,
and the current machine hostname (for example `minipc-wsl`) before reporting LM
Studio as offline.

Gemma 4 may support a much larger theoretical context window than the value LM
Studio actually loads for a specific model session. If LM Studio reports errors
like `n_keep >= n_ctx`, increase the model's loaded context length in LM Studio
or reduce this app's prompt plus completion budget to fit inside the active
`n_ctx`.

Optional API CORS overrides for a GitHub Pages-hosted frontend:

```bash
export GEMMA_AGENT_PWA_CORS_ORIGINS=https://YOUR-USER.github.io
```

## Commands

```bash
pnpm install
pnpm dev
pnpm test
pnpm test:e2e
pnpm typecheck
pnpm build
pnpm lint
```

## Usability

- The web UI now supports **light and dark themes** with a persistent theme toggle.
- Keyboard navigation is built into the section jump controls, toggle groups, agent/session lists, and composer.
- Shortcuts: press `/` to focus the composer, `Ctrl`/`Cmd` + `Enter` to send, and `Alt` + `1` through `4` to jump between **Agents**, **History**, **Chat**, and **Details**.
- The mobile layout keeps section navigation visible and the composer pinned near the bottom of the active panel for easier one-handed use.

`pnpm dev` now picks a matched free web/API port pair automatically, then prints
the selected URLs before launching both processes. In dev, the browser stays on
same-origin `/api` requests and Vite proxies them to the selected API port, so
hostname URLs like `http://minipc-wsl:55008/` keep working. This also avoids the
shared environment collisions around `55006` and `8787`.

The API now mirrors chat debug events into the `pnpm dev` terminal output, so
you can inspect each request, tool call, tool result, stream error, and saved
response without relying on the in-app details panel.

If you run the apps separately, the defaults are still `http://localhost:55006`
for the web app and `http://localhost:8787` for the API. The Vite dev server
also allows the local hostname plus detected Tailscale MagicDNS hosts (for
example `http://minipc-wsl.tail2e322f.ts.net:55008/`) by default; add more
hosts with `GEMMA_AGENT_PWA_ALLOWED_HOSTS=host1,host2`, or paste a full URL and
the dev server will whitelist both that hostname and its parent domain.

## GitHub Pages

The repository includes a GitHub Actions workflow that publishes `apps/web/dist` to GitHub Pages on every push to `main`.

- The build sets the Vite base path to `/<repo-name>/` automatically.
- By default, the published frontend points at `http://minipc.local/api`.
- To point the Pages build at a different API, set a repository variable named `VITE_API_BASE_URL`.

## Notes

- Agent prompts are composed from `AGENT.md`, `SOUL.md`, and enabled skill documents in `min-kb-store`.
- Skills remain file-based `SKILL.md` bundles; executable skills can use the legacy top-level `run.*` convention or a single script inside `scripts/` for compatibility with the open Agent Skills layout.
- Structured JSON skill-call bodies are forwarded to executable skills through stdin/env and translated into CLI flags like `--field value` for better compatibility with legacy scripts; single-field JSON inputs can also fall back to a positional argument when a skill rejects unknown flags.
- The API skill loop now strips transient tool-call/planning text from the live chat, supports legacy Agent Skills `<|tool_call|>` blocks, and re-prompts for a plain-language final answer after skill results.
- Sessions are stored in the canonical `SESSION.md` + `turns/*.md` format.
- Assistant thinking is stored alongside turn metadata but only shown behind an explicit disclosure in the UI.
