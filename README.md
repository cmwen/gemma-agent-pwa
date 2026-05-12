# Gemma Agent PWA

Local-first chat PWA for `min-kb-store` agents, optimized for LM Studio with Gemma models and fast thinking-mode switching.

## What it includes

- React + Vite PWA frontend
- Hono local API runtime
- `min-kb-store` bridge for agent discovery and Markdown chat history
- LM Studio OpenAI-compatible streaming chat integration
- Optional request/response speech via `min-speech-service` for hands-free turns
- Gemma presets for **Fast**, **Balanced**, and **Deep**
- Separate persistence for visible assistant output and captured thinking metadata
- Optional browser notifications for completed background replies
- Recurring scheduled tasks with hourly, daily, and weekly cadences
- Planner-run orchestration where planner agents dispatch tasker agents with resume support

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
- Optional for hands-free turns: `min-speech-service` plus a local OpenAI-compatible speech backend such as `speaches`

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

Optional speech-service override:

```bash
export MIN_SPEECH_SERVICE_URL=http://127.0.0.1:8790
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

## Hands-free chat setup

Speech support enables **hands-free chat**: speak a prompt, let the app
transcribe it into the chat flow, optionally auto-send it for a hands-free turn,
then play the assistant's final reply back as audio.

This stays a **request/response** experience, not live realtime voice chat. The
assistant finishes generating its full reply before spoken playback starts.

1. In `/home/cmwen/dev/min-speech-service`, start the recommended local speech backend:

   ```bash
   docker compose -f compose.dev.yml up -d
   ```

2. In `/home/cmwen/dev/min-speech-service`, copy the local env file if needed:

   ```bash
   cp .env.example .env
   ```

3. In `/home/cmwen/dev/min-speech-service`, start `min-speech-service`:

   ```bash
   pnpm install
   pnpm dev
   ```

4. Verify the speech service:

   ```bash
   curl http://127.0.0.1:8790/health
   curl http://127.0.0.1:8790/v1/capabilities
   ```

5. Start LM Studio with its OpenAI-compatible server enabled, then export your app env:

   ```bash
   export MIN_KB_STORE_ROOT=/absolute/path/to/min-kb-store
   export MIN_SPEECH_SERVICE_URL=http://127.0.0.1:8790
   ```

6. Start this app with `pnpm dev`.

Notes:

- Browser speech calls stay behind this app's `/api/speech/*` proxy instead of
  calling `min-speech-service` directly from the frontend.
- If speech is offline or misconfigured, the UI now surfaces the proxied root
  cause from `min-speech-service` instead of a generic playback/transcription
  failure.
- Browser microphone permission is required for voice input.
- Voice turns stay **turn-based**: tap **Tap to speak**, talk normally, then the
  recorder stops after you pause for a moment. You can still tap
  **Stop listening** to finish sooner. After transcription, the app either
  auto-sends or appends the transcript to the composer.
- The composer now keeps **Hands-free** and **Auto-play** toggles visible, and
  the same preferences also remain available in **Details → Speech**.
- Spoken prompts only auto-send when **Hands-free** is on **and** the composer
  is empty. Otherwise the transcript is appended so you can review or edit it.
- Each completed assistant reply keeps a **Play reply** action. **Auto-play**
  only applies to final assistant replies, and only while the app is visible.
- Spoken replies strip Markdown formatting before synthesis so headings, links,
  and inline code are read more naturally.
- The preferred browser upload format is `audio/webm;codecs=opus`; the default
  spoken reply format is `wav`.
- The first transcription or synthesis request can be slower while local speech
  models warm up.

## Scheduled tasks

- Create recurring prompts from the **Details** panel for the selected agent.
- Supported cadences: **hourly**, **daily**, and **weekly**.
- Schedules run on the API side, so they keep their cadence even if the PWA
  tab reconnects later.
- Each schedule can either reuse a dedicated thread or create a fresh chat on
  every run.
- Manual **Run now**, pause/resume, edit, delete, recent outcome, and next-run
  state are all available in-app.

### Mobile and PWA behavior

- The selected agent's schedule panel refreshes about every minute while the
  schedule UI is visible and the app is active. Cross-agent completion
  monitoring only polls in the background when notifications are enabled,
  slows down when the next scheduled run is still far away, and pauses when
  offline.
- Completion alerts reuse the existing browser/service-worker notification path,
  so installed PWAs on mobile can still surface finished runs without an
  aggressive reconnect loop.
- Mobile browsers can still suspend background work entirely, so notifications
  and status refresh are **best effort** while the app is fully closed.

## Behavior contracts

- Runtime config resolution flows from app defaults to agent defaults to session
  state to the current request. Later sources win, and the selected preset fills
  any unset thinking, token, context, temperature, and `topP` values.
- Dev host allowlists and API CORS origins come from the same network helper
  logic. The app auto-allows localhost, `127.0.0.1`, detected machine hostnames,
  and detected Tailscale DNS/IP entries; add more hosts with
  `GEMMA_AGENT_PWA_ALLOWED_HOSTS` and more origins with
  `GEMMA_AGENT_PWA_CORS_ORIGINS`.
- Chat streaming uses newline-delimited JSON events that match the shared
  `ChatStreamEvent` contract, and the web client validates each parsed event
  before applying it.
- User prompts are forwarded to the configured LLM backend as plain chat text.
  LM Studio remains the only configured LLM backend today, while the provider
  interface stays open for future adapters.
- Scheduled task cadence is stored with the agent, next-run timestamps are
  computed from the task timezone, and missed runs are resumed with a single
  catch-up execution instead of replaying every missed interval.
- Planner-run state is persisted under
  `memory/gemma-agent-pwa/planner-runs/<planner-agent-id>.json`; each task
  stores status, attempt count, errors, and tasker session references so
  failed runs can resume from the first non-success step.

## Usability

- The web UI now supports **light and dark themes** with a persistent theme toggle.
- Optional reply notifications can be enabled from **Details** so completed background runs can alert you.
- Keyboard navigation is built into the section jump controls, toggle groups, agent/session lists, and composer.
- Shortcuts: press `/` to focus the composer, `Ctrl`/`Cmd` + `Enter` to send, and `Alt` + `1` through `4` to jump between **Agents**, **History**, **Chat**, and **Details**.
- The mobile layout keeps the composer pinned near the bottom of the active panel, and the chat header plus top controls collapse while you scroll down through a conversation so more of the thread stays visible.

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
- The API skill loop now strips transient tool-call/planning text from the live chat, supports legacy Agent Skills `<|tool_call|>` blocks, and can continue across multiple skill iterations before producing the final plain-language answer.
- Sessions are stored in the canonical `SESSION.md` + `turns/*.md` format.
- Assistant thinking is stored alongside turn metadata but only shown behind an explicit disclosure in the UI.
