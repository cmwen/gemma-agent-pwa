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
| `GET /api/health` | Workspace summary plus LM Studio availability |
| `GET /api/models` | LM Studio model catalog |
| `GET /api/speech/health` | Reachability and configured speech defaults from `min-speech-service` |
| `GET /api/speech/capabilities` | Browser-facing STT/TTS capability discovery |
| `POST /api/speech/transcriptions` | Proxy browser microphone uploads to speech-to-text |
| `POST /api/speech/speech` | Proxy assistant reply synthesis and stream audio bytes back |
| `GET /api/agents` | Agent summaries from `min-kb-store` |
| `GET /api/agents/:agentId` | Single agent details |
| `GET /api/agents/:agentId/sessions` | Session history for an agent |
| `GET /api/agents/:agentId/sessions/:sessionId` | Full session with turns |
| `DELETE /api/agents/:agentId/sessions/:sessionId` | Soft or permanent delete |
| `POST /api/agents/:agentId/sessions/:sessionId/restore` | Restore a soft-deleted session |
| `POST /api/agents/:agentId/chat` | Start or continue a streaming chat |

## Key modules

- `src/index.ts`: route wiring, CORS, and stream orchestration
- `src/chat-loop.ts`: model call / skill call loop
- `src/agent-skills.ts`: skill discovery, prompt instructions, parser, and script execution
- `src/chat-session.ts`: session safety helpers for deleted or replaced threads
- `src/lmstudio.ts`: LM Studio model discovery and streaming client
- `src/chat-debug.ts`: structured debug logging for dev output

## Speech integration

- The API keeps browser speech calls on the same origin and forwards them to `min-speech-service`.
- It validates health/capability JSON and synthesis/transcription payloads with shared Zod schemas from `@gemma-agent-pwa/contracts`.
- This repo's speech scope is **turn-based request/response** audio, not realtime proxying.

## Local development

```bash
pnpm --filter @gemma-agent-pwa/api dev
pnpm --filter @gemma-agent-pwa/api build
pnpm test
```

The API expects `MIN_KB_STORE_ROOT` to point at a valid `min-kb-store` checkout. `LM_STUDIO_BASE_URL` and `LM_STUDIO_MODEL` can override the default local LM Studio connection. Set `MIN_SPEECH_SERVICE_URL` when the speech facade is not running on `http://127.0.0.1:8790`.
