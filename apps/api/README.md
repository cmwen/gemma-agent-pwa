# `@gemma-agent-pwa/api`

Local Hono API for the PWA. It exposes agent, session, model, and chat routes, then coordinates LM Studio streaming with `min-kb-store` persistence.

## Main responsibilities

- Resolve the workspace and expose HTTP endpoints from `src/index.ts`
- Run the chat loop in `src/chat-loop.ts`
- Load and execute file-based skills from `src/agent-skills.ts`
- Stream newline-delimited `ChatStreamEvent` payloads from `@gemma-agent-pwa/contracts`
- Persist chat turns through `@gemma-agent-pwa/min-kb-bridge`

## Routes

| Route | Purpose |
| --- | --- |
| `GET /api/workspaces` | List configured workspaces/tenants |
| `GET /api/health` | Workspace summary plus LM Studio availability |
| `GET /api/models` | LM Studio model catalog |
| `GET /api/speech/health` | Reachability and configured speech defaults from `min-speech-service` |
| `GET /api/speech/capabilities` | Browser-facing STT/TTS capability discovery |
| `POST /api/speech/transcriptions` | Proxy browser microphone uploads to speech-to-text |
| `POST /api/speech/speech` | Proxy assistant reply synthesis and stream audio bytes back |
| `POST /api/speech/npl` | Proxy transcript cleanup, intent detection, and translation |
| `GET /api/agents` | Agent summaries from `min-kb-store` |
| `GET /api/agents/:agentId` | Single agent details |
| `GET /api/agents/:agentId/sessions` | Session history for an agent |
| `GET /api/agents/:agentId/sessions/:sessionId` | Full session with turns |
| `DELETE /api/agents/:agentId/sessions/:sessionId` | Soft or permanent delete |
| `POST /api/agents/:agentId/sessions/:sessionId/restore` | Restore a soft-deleted session |
| `POST /api/agents/:agentId/chat` | Start or continue a streaming chat |
| `GET /api/planner-runs` | List planner orchestration runs (optionally by planner agent) |
| `POST /api/planner-runs` | Create a planner run with tasker steps |
| `GET /api/planner-runs/:plannerAgentId/:runId` | Read one planner run |
| `POST /api/planner-runs/:plannerAgentId/:runId/execute` | Execute pending/non-success tasker steps |
| `POST /api/planner-runs/:plannerAgentId/:runId/resume` | Resume a failed/incomplete planner run |

## Key modules

- `src/index.ts`: route wiring, CORS, and stream orchestration
- `src/chat-loop.ts`: model call / skill call loop
- `src/agent-skills.ts`: skill discovery, prompt instructions, parser, and script execution
- `src/chat-session.ts`: session safety helpers for deleted or replaced threads
- `src/lmstudio.ts`: LM Studio model discovery and streaming client
- `src/chat-debug.ts`: structured debug logging for dev output

## Speech integration

- The API keeps browser speech calls on the same origin and forwards them to `min-speech-service`.
- It validates health/capability JSON plus synthesis, transcription, and NPL/text-processing payloads with shared Zod schemas from `@gemma-agent-pwa/contracts`.
- This repo's speech scope is **turn-based request/response** audio, not realtime proxying.

## Local development

```bash
pnpm --filter @gemma-agent-pwa/api dev
pnpm --filter @gemma-agent-pwa/api build
pnpm test
```

The API expects `MIN_KB_STORE_ROOT` to point at a valid `min-kb-store`
checkout. Set `MIN_KB_TEST_STORE_ROOT` to expose a second testing workspace in
the same server process. Workspace-scoped routes accept `?workspace=<id>` and
fall back to `default` when the parameter is omitted. `LM_STUDIO_BASE_URL` and
`LM_STUDIO_MODEL` can override the default local LM Studio connection. Set
`MIN_SPEECH_SERVICE_URL` when the speech facade is not running on
`http://127.0.0.1:8790`.
