# Gemma Agent PWA Architecture

This document describes how the app is built, which modules own which responsibilities, how model roles are split, how the core thinking loop works, and how delegation works today.

## 1. Build and runtime architecture

## Monorepo packages

| Package | Stack | Responsibility |
| --- | --- | --- |
| `apps/web` | React 19 + Vite + React Query + Zustand | PWA UI, chat composer/thread rendering, stream consumption, voice UX, schedule/planner controls |
| `apps/api` | Hono + Node + AG-UI encoder | Local API, chat orchestration, model/provider calls, stream event mapping, persistence coordination |
| `packages/contracts` | Zod + TypeScript | Shared schemas/types/defaults across web/api/bridge |
| `packages/min-kb-bridge` | Node fs + gray-matter | Filesystem adapter for `min-kb-store` agents, sessions, skills, schedules, planner runs |

## Build pipeline

1. Root `pnpm -r build` runs each workspace package build.
2. `apps/web` builds with Vite.
3. `apps/api`, `packages/contracts`, and `packages/min-kb-bridge` build with `tsup`.
4. Shared runtime contracts are compiled once in `packages/contracts` and reused by API + web.

## Runtime topology

```text
Browser PWA (apps/web)
  -> /api/* (same origin)
Hono API (apps/api)
  -> min-kb-bridge (filesystem reads/writes into min-kb-store)
  -> LM Studio OpenAI-compatible endpoint (LLM streaming)
  -> min-speech-service (optional request/response speech)
```

---

## 2. Module map and responsibilities

## `apps/web/src`

| Module | Responsibility |
| --- | --- |
| `App.tsx` | App shell, panel layout, chat lifecycle, streaming state, thread rendering, schedule editor, speech controls |
| `lib/api.ts` | Typed HTTP helpers and NDJSON stream parsing (`streamChat`) |
| `lib/store.ts` | Persisted UI state (workspace/agent/session selection, drafts, theme, speech preferences) |
| `app-utils.ts` | Pure UI helpers (message shaping, polling intervals, formatting, notifications, markdown-to-plain-text) |
| `main.tsx` | React root, QueryClient setup, PWA service worker registration |

## `apps/api/src`

| Module | Responsibility |
| --- | --- |
| `app.ts` | Route registration and end-to-end chat request handling (normal + orchestrator paths) |
| `chat-loop.ts` | Core multi-iteration LLM/tool loop |
| `agent-skills.ts` | Skill discovery instructions, skill-call parsing, executable script runtime |
| `tool-runtime.ts` | Runtime tool registry/execution (`load-skill`, extra tools filtering) |
| `llm-provider.ts` | Provider adapter facade (currently LM Studio only) |
| `lmstudio.ts` | LM Studio model listing + streaming adapter + prompt shaping for tools/skills |
| `orchestrator.ts` | Built-in stateless router agent that chooses a specialist agent |
| `planner-runs.ts` | Planner-run API and execution engine for planner -> tasker workflows |
| `ag-ui-mapper.ts` | Maps internal snapshots/tool events to AG-UI stream events |
| `scheduled-tasks.ts` | Recurring schedule runner and schedule CRUD endpoints |
| `chat-session.ts` | Guards for deleted/replaced sessions during write-back |

## `packages/min-kb-bridge/src`

| Module | Responsibility |
| --- | --- |
| `workspace.ts` | Resolve/summarize one or more workspaces |
| `agents.ts` | Load `AGENT.md`/`SOUL.md`, resolve kind, delegated targets, skills |
| `sessions.ts` | Read/write turns, thread metadata, soft delete/restore/permanent delete |
| `schedules.ts` | Persist recurring scheduled tasks |
| `planner-runs.ts` | Persist planner run state under `memory/gemma-agent-pwa/planner-runs` |
| `runtime-config.ts` | Parse persisted runtime config (`RUNTIME.json`) |

---

## 3. Model and preset responsibilities

## Provider responsibility

- The runtime supports one configured provider: **LM Studio** (`provider = "lmstudio"`).
- `requireConfiguredProvider` rejects unsupported providers at parse/runtime boundaries.

## Gemma preset responsibilities

From `packages/contracts/src/index.ts`:

| Preset ID | Display name | Responsibility | Key behavior |
| --- | --- | --- | --- |
| `gemma4-fast` | Gemma Fast | Quick drafting and short replies | Thinking off, lower token budget |
| `gemma4-balanced` | Gemma Balanced | Default day-to-day planning/analysis | Thinking on, medium token budget |
| `gemma4-deep` | Gemma Deep | Harder multi-step tasks | Thinking on, largest token budget |

Preset defaults are merged with agent/session/request overrides via `mergeRuntimeConfig`, then normalized through `chatRuntimeConfigSchema`.

## Runtime model selection responsibilities

| Flow | Model selection rule |
| --- | --- |
| Normal chat (`app.ts`) | Prefer `gemma-4*`, then `isGemma`, else first available |
| Orchestrator routing (`orchestrator.ts`) | Prefer smallest fast Gemma route model (`gemma-4.*e4b`, then `gemma-4`, then `gemma`) |
| Planner-task execution (`planner-runs.ts`) | Prefer default available Gemma model, then agent config/default |
| Title generation (`app.ts`) | Reuses merged config model with tiny budget and thinking off |

---

## 4. Core thinking loop (`runChatLoop`)

The core loop is implemented in `apps/api/src/chat-loop.ts`.

1. Call `streamProviderChat` with current conversation + agent prompt + enabled skills/tools.
2. Parse assistant output for skill/tool calls (`parseSkillCalls`).
3. Strip tool-call markup from visible assistant text (`stripSkillCalls`).
4. If no calls are found, finish with assistant output.
5. If calls exist, emit stream events:
   - `assistant_snapshot` (clear/hide in-flight text)
   - `skill_call` per call
6. Execute each call:
   - Runtime tools via `executeToolCall`
   - Executable skills via `executeSkillScript`
   - Missing/unavailable calls return explicit error tool results
7. Emit `skill_result` event for each completed call.
8. Append tool outputs and a finalize system instruction to the synthetic conversation.
9. Repeat until the model responds without tool calls or max iterations is reached.

Important loop behavior:

- Max iterations: **5**
- LLM stats are accumulated across loop iterations.
- If the final assistant text is empty, loop falls back to last useful tool output summary.
- All loop stages generate structured debug logs (`chat-debug.ts`).

---

## 5. How delegation works

Delegation exists in three layers:

## A) Orchestrator routing delegation (active)

- Virtual orchestrator agent ID: `_orchestrator`.
- For `/api/agents/_orchestrator/chat`, API:
  1. Extracts latest user prompt.
  2. Runs one fast routing LLM call (`routeToAgent`) with candidate agent list.
  3. Picks the target specialist agent.
  4. Persists user/assistant turns directly under the target agent session.
- The orchestrator itself stays stateless/sessionless and acts as router only.

## B) Planner -> tasker delegation (active)

- Planner runs are created/executed in `planner-runs.ts`.
- Each non-success task is run by a target tasker agent with its own thread.
- Task statuses persist as `pending -> running -> success/error`.
- Runs can be resumed from the first non-success task.

## C) `delegate-task` tool path (partially wired, currently not enabled in chat runtime)

- `DELEGATION_TOOL_NAME` is reserved as `delegate-task`.
- `tool-runtime.ts` currently returns:
  - `"Delegation tool is not configured in this runtime."`
- `app.ts` also drops client-provided `delegate-task` from `input.tools`.
- A full delegated execution implementation exists in `delegation.ts` (`executeDelegatedAgentTool`) but is not the active path in the current chat route wiring.

So, effective delegation today is:

1. **Automatic routing** through orchestrator, and
2. **Planner-run task dispatch** to taskers.

---

## 6. Request/response and stream flow

1. Web sends `POST /api/agents/:agentId/chat`.
2. API persists user turn first.
3. API starts AG-UI stream and emits snapshots/tool events.
4. `runChatLoop` produces final assistant text (+ optional thinking trace).
5. API persists assistant turn + LLM usage stats.
6. Final stream completion event returns updated thread.
7. Web updates timeline, details console, and optional speech playback path.
