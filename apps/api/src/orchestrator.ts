/**
 * Built-in Orchestrator Agent
 *
 * The orchestrator is a lightweight, stateless intent dispatcher that:
 *   - Reads each user message independently (no accumulated routing context)
 *   - Selects the most suitable specialist agent using a single fast LLM call
 *   - Forwards the user's raw prompt unchanged to the chosen agent
 *   - Logs routing decisions to the debug channel for observability
 *   - Prefers the smallest, fastest available model (gemma-4-e4b variants first)
 *
 * Design decisions:
 *   - Virtual agent: not backed by a filesystem directory; injected by the API layer
 *   - Stateless routing: conversation history is never used to make routing decisions
 *   - No own sessions: the orchestrator does not save sessions; the target agent does
 *   - Fast: routing uses minimal tokens (50), zero temperature, and no thinking
 *   - Pinned: always appears first in the agent list regardless of alphabetical order
 *
 * Debug logging: every routing decision is logged via `logChatDebugMessage` so
 * developers can trace which agent was chosen and why.
 */

import path from "node:path";
import type {
  AgentSummary,
  ChatRuntimeConfig,
  ModelDescriptor,
} from "@gemma-agent-pwa/contracts";
import { GEMMA_BALANCED_PRESET_ID } from "@gemma-agent-pwa/contracts";
import type { MinKbWorkspace } from "@gemma-agent-pwa/min-kb-bridge";
import { logChatDebugMessage } from "./chat-debug.js";
import { streamProviderChat } from "./llm-provider.js";

/** Stable ID for the built-in orchestrator agent. */
export const ORCHESTRATOR_AGENT_ID = "_orchestrator";

const ORCHESTRATOR_TITLE = "Orchestrator";
const ORCHESTRATOR_DESCRIPTION =
  "Automatically routes your message to the most suitable specialist agent.";

/**
 * Model ID patterns tried in order when selecting the routing model.
 * Smaller/faster variants are listed first to minimise routing latency.
 */
const ORCHESTRATOR_MODEL_PATTERNS: RegExp[] = [
  /gemma-4.*e4b/i,
  /gemma-4/i,
  /gemma/i,
];

/** Maximum completion tokens for the routing response.  Agent IDs are short. */
const ROUTING_MAX_TOKENS = 50;

/** Zero temperature produces deterministic, repeatable routing decisions. */
const ROUTING_TEMPERATURE = 0.0;

// ---------------------------------------------------------------------------
// Virtual agent summary
// ---------------------------------------------------------------------------

/**
 * Build the virtual AgentSummary for the orchestrator.
 *
 * The orchestrator is not backed by a filesystem agent directory. Path fields
 * are set to the would-be location inside the workspace so that the schema
 * validation passes and any future on-demand seeding is straightforward.
 */
export function buildOrchestratorAgentSummary(
  workspace: MinKbWorkspace
): AgentSummary {
  const agentRoot = path.join(workspace.agentsRoot, ORCHESTRATOR_AGENT_ID);
  return {
    id: ORCHESTRATOR_AGENT_ID,
    kind: "orchestrator",
    title: ORCHESTRATOR_TITLE,
    description: ORCHESTRATOR_DESCRIPTION,
    combinedPrompt: ORCHESTRATOR_DESCRIPTION,
    agentPath: agentRoot,
    defaultSoulPath: path.join(agentRoot, "SOUL.md"),
    historyRoot: path.join(agentRoot, "history"),
    workingMemoryRoot: path.join(agentRoot, "notes"),
    skillRoot: path.join(agentRoot, "skills"),
    skillNames: [],
    delegatedAgentIds: [],
    sessionCount: 0,
  };
}

// ---------------------------------------------------------------------------
// Model selection
// ---------------------------------------------------------------------------

/**
 * Select the best available model for routing calls.
 *
 * Tries each pattern in `ORCHESTRATOR_MODEL_PATTERNS` in order. Falls back to
 * `defaultModel` when no pattern matches any loaded model.
 */
export function chooseOrchestratorModel(
  models: ModelDescriptor[],
  defaultModel: string
): string {
  for (const pattern of ORCHESTRATOR_MODEL_PATTERNS) {
    const match = models.find((m) => pattern.test(m.id));
    if (match) {
      return match.id;
    }
  }
  return defaultModel;
}

// ---------------------------------------------------------------------------
// Routing config
// ---------------------------------------------------------------------------

/**
 * Build the ChatRuntimeConfig used for the single routing LLM call.
 *
 * Optimised for minimum latency:
 *   - Very low token budget (agent IDs are a few characters)
 *   - Zero temperature (deterministic output)
 *   - Thinking disabled (no chain-of-thought overhead)
 */
export function buildOrchestratorRoutingConfig(
  model: string
): ChatRuntimeConfig {
  return {
    provider: "lmstudio",
    model,
    presetId: GEMMA_BALANCED_PRESET_ID,
    disabledSkills: [],
    maxCompletionTokens: ROUTING_MAX_TOKENS,
    temperature: ROUTING_TEMPERATURE,
    lmStudioEnableThinking: false,
  };
}

// ---------------------------------------------------------------------------
// Routing system prompt
// ---------------------------------------------------------------------------

/**
 * Build the system prompt that instructs the LLM to select a target agent.
 *
 * Lists each candidate agent with its ID, title, and description. The model
 * is instructed to respond with only the agent ID — no explanation needed.
 */
export function buildRoutingSystemPrompt(agents: AgentSummary[]): string {
  const agentLines = agents
    .map((a) => `- ${a.id}: "${a.title}" — ${a.description}`)
    .join("\n");

  return [
    "You are an intent router. Pick the best agent for the user message.",
    "",
    "Available agents:",
    agentLines,
    "",
    "Rules:",
    "- Reply with ONLY the agent ID, nothing else.",
    "- One line, no punctuation, no explanation.",
    "- If no agent fits, output the first agent ID in the list.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Routing call
// ---------------------------------------------------------------------------

export interface RoutingResult {
  /** The chosen target agent. */
  agent: AgentSummary;
  /** Raw text returned by the routing LLM (useful for debug logging). */
  rawResponse: string;
  /** Wall-clock time the routing call took in milliseconds. */
  durationMs: number;
}

/**
 * Run a single fast LLM call to select the target agent.
 *
 * The model is expected to respond with exactly the agent ID. The response is
 * matched case-insensitively against candidate IDs and titles. Falls back to
 * the first candidate if the LLM produces an invalid or empty response.
 *
 * This function never throws — LLM errors return a fallback result.
 */
export async function routeToAgent(options: {
  systemPrompt: string;
  userMessage: string;
  model: string;
  config: ChatRuntimeConfig;
  candidates: AgentSummary[];
}): Promise<RoutingResult> {
  const startedAt = performance.now();

  const result = await streamProviderChat({
    model: options.model,
    config: options.config,
    conversation: [
      {
        bodyMarkdown: options.userMessage,
        createdAt: new Date().toISOString(),
        messageId: "orchestrator-route",
        relativePath: "in-flight",
        sender: "user",
      },
    ],
    agentPrompt: options.systemPrompt,
    enabledSkills: [],
    onSnapshot: () => undefined,
  }).catch(() => null);

  const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
  const rawResponse = result?.assistantText?.trim() ?? "";
  const normalizedResponse = rawResponse.toLowerCase();

  const agent =
    options.candidates.find(
      (a) =>
        a.id.toLowerCase() === normalizedResponse ||
        a.title.toLowerCase() === normalizedResponse
    ) ?? options.candidates[0];

  return { agent: agent!, rawResponse, durationMs };
}

// ---------------------------------------------------------------------------
// Debug logging
// ---------------------------------------------------------------------------

/**
 * Build a debug log entry describing a successful routing decision.
 *
 * Logged via `logChatDebugMessage` so developers can trace which agent was
 * chosen, the raw model response, and how long the routing call took.
 */
export function logOrchestratorRoutingDecision(options: {
  model: string;
  userPrompt: string;
  rawResponse: string;
  chosenAgentId: string;
  durationMs: number;
  candidateCount: number;
}): void {
  logChatDebugMessage({
    level: "info",
    text: [
      `Orchestrator routing · model=${options.model} · ${options.durationMs}ms`,
      "",
      `User prompt\n${options.userPrompt.slice(0, 300)}${options.userPrompt.length > 300 ? "…" : ""}`,
      "",
      `Raw model response\n${options.rawResponse || "(empty)"}`,
      "",
      `Chosen agent\n${options.chosenAgentId} (from ${options.candidateCount} candidates)`,
    ].join("\n"),
  });
}

/**
 * Build a debug log entry when routing falls back to the default agent.
 *
 * Logged when the routing call fails or the model returns an unrecognised ID.
 */
export function logOrchestratorFallback(options: {
  reason: string;
  fallbackAgentId: string;
}): void {
  logChatDebugMessage({
    level: "error",
    text: [
      `Orchestrator fallback · reason=${options.reason}`,
      "",
      `Fallback agent\n${options.fallbackAgentId}`,
    ].join("\n"),
  });
}
