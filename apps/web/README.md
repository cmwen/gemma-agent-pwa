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
- `src/lib/api.ts`: typed API helpers and NDJSON stream parsing
- `src/lib/store.ts`: selected agent/session state, drafts, and theme persistence
- `src/app-utils.ts`: presentation helpers used across the app shell
- `src/styles.css`: responsive layout and theme styles

## Data flow

1. React Query loads health, model, agent, and session data from the API.
2. `streamChat` posts a `ChatRequest` and parses streamed `ChatStreamEvent` lines.
3. Incoming events update the live thread, details console, and cached session data.
4. Zustand persists lightweight UI state such as selected sessions, drafts, and theme mode.

## Local development

```bash
pnpm --filter @gemma-agent-pwa/web dev
pnpm --filter @gemma-agent-pwa/web build
pnpm test
```

`VITE_API_BASE_URL` can point the app at a non-default API origin. When it is unset, the app uses same-origin `/api` requests.
