# `@gemma-agent-pwa/web`

React + Vite PWA frontend for browsing agents, managing chat history, and streaming local Gemma responses.

## Main responsibilities

- Render the app shell from `src/App.tsx`
- Keep UI-only behavior in `src/app-utils.ts`
- Call the local API through `src/lib/api.ts`
- Persist client state and draft selection in `src/lib/store.ts`
- Validate streamed chat events with shared contracts

## Important modules

- `src/App.tsx`: top-level queries, layout, streaming state, and keyboard interactions
- `src/lib/api.ts`: typed API helpers, speech proxy calls, and NDJSON stream parsing
- `src/lib/store.ts`: selected agent/session state, drafts, theme persistence, speech toggles, and schedule notification markers
- `src/app-utils.ts`: presentation helpers used across the app shell
- `src/styles.css`: responsive layout and theme styles

## Data flow

1. React Query loads health, model, agent, session, and scheduled-task data from the API.
2. `streamChat` posts a `ChatRequest` and parses streamed `ChatStreamEvent` lines.
3. Voice turns record in the browser, upload audio through `/api/speech/transcriptions`, refine the transcript through `/api/speech/npl`, and can auto-send the cleaned prompt when hands-free mode is on and the composer is empty.
4. Completed assistant replies can be synthesized through `/api/speech/speech` for manual playback or visible-tab auto-play.
5. Incoming events update the live thread, details console, and cached session data.
6. Scheduled-task completion polling slows down in the background so the PWA does not burn battery on mobile.
7. Zustand persists lightweight UI state such as selected sessions, drafts, theme mode, speech preferences, and the last scheduled run that has already been surfaced locally.

## Voice UX

- The current voice experience is intentionally **request/response**, not live realtime chat.
- A spoken turn is: **tap to speak → pause to auto-stop → transcribe → clean/rewrite the prompt → auto-send or review → hear the final reply**.
- **Hands-free** controls whether an empty composer auto-sends the transcript; if the composer already has text, the transcript is appended for review.
- **Auto-play** only applies to completed assistant replies while the app is visible. Manual **Play reply** stays available on assistant messages.

## Local development

```bash
pnpm --filter @gemma-agent-pwa/web dev
pnpm --filter @gemma-agent-pwa/web build
pnpm test
```

`VITE_API_BASE_URL` can point the app at a non-default API origin. When it is unset, the app uses same-origin `/api` requests.

For local speech input/output, also run `min-speech-service` and keep the API pointed at it through `MIN_SPEECH_SERVICE_URL` in the repo root setup.
