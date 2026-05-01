# `@gemma-agent-pwa/contracts`

Shared runtime contracts for the API, web app, and bridge package. This package centralizes Zod schemas, inferred types, and Gemma runtime preset helpers.

## What lives here

- Zod schemas and inferred types for agents, sessions, turns, attachments, health status, chat requests, and streamed chat events
- Default Gemma runtime presets and preset IDs
- Runtime config normalization and merge helpers
- Shared model and provider defaults

## Common exports

- `chatRequestSchema`, `chatStreamEventSchema`, `healthStatusSchema`
- `agentSummarySchema`, `chatSessionSchema`, `chatTurnSchema`
- `GEMMA_PRESETS`, `GEMMA_FAST_PRESET_ID`, `GEMMA_BALANCED_PRESET_ID`, `GEMMA_DEEP_PRESET_ID`
- `mergeRuntimeConfig`, `normalizeRuntimeConfig`, `applyPresetRuntimeConfigDefaults`, `getPresetById`

## Typical usage

```ts
import { mergeRuntimeConfig, chatStreamEventSchema } from "@gemma-agent-pwa/contracts";

const config = mergeRuntimeConfig(agentDefaults, sessionConfig, requestConfig);
const event = chatStreamEventSchema.parse(JSON.parse(line));
```

Use this package for anything that must stay consistent across workspace boundaries. If the API emits it and the web app reads it, the shape belongs here.
