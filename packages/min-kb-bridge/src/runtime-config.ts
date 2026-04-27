import type { ChatRuntimeConfig } from "@gemma-agent-pwa/contracts";
import {
  chatRuntimeConfigSchema,
  DEFAULT_PROVIDER,
} from "@gemma-agent-pwa/contracts";

export function parsePersistedRuntimeConfig(
  rawConfig: string
): ChatRuntimeConfig | undefined {
  const parsed = parseRuntimeConfigObject(JSON.parse(rawConfig));
  const provider = normalizeProvider(
    readOptionalTrimmedString(parsed.provider)
  );
  if (provider !== DEFAULT_PROVIDER) {
    return undefined;
  }

  return chatRuntimeConfigSchema.parse({
    model: readOptionalTrimmedString(parsed.model),
    presetId: readOptionalTrimmedString(parsed.presetId),
    lmStudioEnableThinking: readOptionalBoolean(
      parsed.lmStudioEnableThinking,
      "lmStudioEnableThinking"
    ),
    maxCompletionTokens: readOptionalNumber(
      parsed.maxCompletionTokens,
      "maxCompletionTokens"
    ),
    contextWindowSize: readOptionalNumber(
      parsed.contextWindowSize,
      "contextWindowSize"
    ),
    temperature: readOptionalNumber(parsed.temperature, "temperature"),
    topP: readOptionalNumber(parsed.topP, "topP"),
    disabledSkills: readOptionalStringArray(
      parsed.disabledSkills,
      "disabledSkills"
    ),
    provider,
  });
}

function normalizeProvider(provider?: string): string | undefined {
  if (!provider) {
    return undefined;
  }

  return provider.replace(/\s+/g, "").trim().toLowerCase();
}

function parseRuntimeConfigObject(value: unknown): Record<string, unknown> {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new Error("Runtime config must be a JSON object.");
  }

  return value as Record<string, unknown>;
}

function readOptionalTrimmedString(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error("Expected runtime config field to be a string.");
  }

  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Expected runtime config string field to be non-empty.");
  }

  return trimmed;
}

function readOptionalBoolean(
  value: unknown,
  fieldName: string
): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(
      `Expected runtime config field ${fieldName} to be a boolean.`
    );
  }
  return value;
}

function readOptionalNumber(
  value: unknown,
  fieldName: string
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new Error(
      `Expected runtime config field ${fieldName} to be a number.`
    );
  }
  return value;
}

function readOptionalStringArray(
  value: unknown,
  fieldName: string
): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string")
  ) {
    throw new Error(
      `Expected runtime config field ${fieldName} to be an array of strings.`
    );
  }
  return value;
}
