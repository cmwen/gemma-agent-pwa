# `@gemma-agent-pwa/min-kb-bridge`

Filesystem adapter for reading and writing `min-kb-store` data. It turns Markdown agent bundles, skill documents, and session history into typed workspace objects.

## Main responsibilities

- Resolve the active workspace with `resolveWorkspace`
- Summarize workspace metadata with `summarizeWorkspace`
- Read agent bundles and skill descriptors with `listAgents`, `getAgentById`, and `listSkillsForAgent`
- Load enabled skill documents for prompt assembly
- Read, create, update, soft-delete, restore, and permanently delete chat sessions
- Persist assistant turns, attachments, runtime config, and LLM usage stats

## Workspace expectations

The bridge expects a valid `min-kb-store` root with:

```text
agents/
memory/
skills/
```

Agent sessions are stored as:

```text
history/<session-slug>/SESSION.md
history/<session-slug>/turns/*.md
history/<session-slug>/turns/*.json   # optional metadata such as thinking or attachments
```

## Typical usage

```ts
import {
  getAgentById,
  listSessions,
  resolveWorkspace,
  saveChatTurn,
} from "@gemma-agent-pwa/min-kb-bridge";

const workspace = await resolveWorkspace();
const agent = await getAgentById(workspace, "demo-agent");
const sessions = await listSessions(workspace, "demo-agent");
await saveChatTurn(workspace, {
  agentId: "demo-agent",
  sender: "user",
  bodyMarkdown: "Hello",
});
```

## Module map

- `src/workspace.ts`: workspace discovery and summaries
- `src/agents.ts`: agent contracts, persona composition, and skill discovery
- `src/sessions.ts`: session manifests, turns, attachments, and LLM stats
- `src/runtime-config.ts`: persisted runtime config parsing
- `src/utils.ts`: file and path helpers used across the package
