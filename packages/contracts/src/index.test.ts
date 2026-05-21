import { describe, expect, it } from "vitest";
import {
  applyPresetRuntimeConfigDefaults,
  DEFAULT_CONTEXT_WINDOW_SIZE,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  GEMMA_BALANCED_PRESET_ID,
  GEMMA_DEEP_PRESET_ID,
  mergeRuntimeConfig,
  normalizeLlmRequestStats,
  normalizeLlmSessionStats,
  normalizeProviderId,
  normalizeRuntimeConfig,
  requireConfiguredProvider,
  scheduledTaskCreateSchema,
  scheduledTaskSchema,
  speechCapabilitiesSchema,
  speechHealthSchema,
  textProcessingResultSchema,
} from "./index";

describe("runtime config helpers", () => {
  it("normalizes merged configs before preset defaults are applied", () => {
    expect(
      normalizeRuntimeConfig([
        {
          model: "google/gemma-3-12b",
        },
      ])
    ).toEqual({
      provider: DEFAULT_PROVIDER,
      model: "google/gemma-3-12b",
      presetId: GEMMA_BALANCED_PRESET_ID,
      disabledSkills: [],
    });
  });

  it("fills missing runtime fields from the selected preset", () => {
    expect(
      applyPresetRuntimeConfigDefaults({
        provider: DEFAULT_PROVIDER,
        model: DEFAULT_MODEL,
        presetId: GEMMA_DEEP_PRESET_ID,
        disabledSkills: [],
      })
    ).toMatchObject({
      provider: DEFAULT_PROVIDER,
      model: DEFAULT_MODEL,
      presetId: GEMMA_DEEP_PRESET_ID,
      lmStudioEnableThinking: true,
      maxCompletionTokens: 8192,
      contextWindowSize: DEFAULT_CONTEXT_WINDOW_SIZE,
      temperature: 0.15,
      topP: 0.95,
      disabledSkills: [],
    });
  });

  it("preserves explicit overrides when a later config changes the preset", () => {
    expect(
      mergeRuntimeConfig(
        {
          model: "google/gemma-3-12b",
          presetId: GEMMA_BALANCED_PRESET_ID,
          maxCompletionTokens: 1024,
        },
        {
          presetId: GEMMA_DEEP_PRESET_ID,
          topP: 0.72,
        }
      )
    ).toMatchObject({
      provider: DEFAULT_PROVIDER,
      model: "google/gemma-3-12b",
      presetId: GEMMA_DEEP_PRESET_ID,
      lmStudioEnableThinking: true,
      maxCompletionTokens: 1024,
      contextWindowSize: DEFAULT_CONTEXT_WINDOW_SIZE,
      temperature: 0.15,
      topP: 0.72,
      disabledSkills: [],
    });
  });

  it("keeps the configured LM Studio provider while still applying preset defaults", () => {
    expect(
      applyPresetRuntimeConfigDefaults({
        provider: DEFAULT_PROVIDER,
        model: DEFAULT_MODEL,
        presetId: GEMMA_BALANCED_PRESET_ID,
        disabledSkills: [],
      })
    ).toMatchObject({
      provider: DEFAULT_PROVIDER,
      model: DEFAULT_MODEL,
      presetId: GEMMA_BALANCED_PRESET_ID,
      lmStudioEnableThinking: true,
      maxCompletionTokens: 4096,
      contextWindowSize: DEFAULT_CONTEXT_WINDOW_SIZE,
      temperature: 0.2,
      topP: 0.95,
      disabledSkills: [],
    });
  });

  it("normalizes LM Studio aliases for the active provider", () => {
    expect(normalizeProviderId(" LM Studio ")).toBe(DEFAULT_PROVIDER);
    expect(requireConfiguredProvider(" LM Studio ")).toBe(DEFAULT_PROVIDER);
  });

  it("rejects unsupported providers until another adapter is configured", () => {
    expect(() => requireConfiguredProvider("future-provider")).toThrow(
      'Unsupported LLM provider "future-provider". LM Studio is the only configured provider.'
    );
  });
});

describe("scheduled task schemas", () => {
  it("accepts hourly, daily, and weekly schedules with matching fields", () => {
    expect(
      scheduledTaskCreateSchema.parse({
        agentId: "release-planner",
        title: "Hourly digest",
        prompt: "Summarize the latest activity.",
        recurrence: "hourly",
        minuteOfHour: 15,
        timezone: "Australia/Sydney",
        enabled: true,
        notifyOnCompletion: true,
        sessionMode: "dedicated",
      })
    ).toMatchObject({
      recurrence: "hourly",
      minuteOfHour: 15,
    });

    expect(
      scheduledTaskCreateSchema.parse({
        agentId: "release-planner",
        title: "Daily digest",
        prompt: "Summarize the latest activity.",
        recurrence: "daily",
        minuteOfHour: 30,
        hourOfDay: 9,
        timezone: "Australia/Sydney",
        enabled: true,
        notifyOnCompletion: true,
        sessionMode: "fresh",
      })
    ).toMatchObject({
      recurrence: "daily",
      hourOfDay: 9,
    });

    expect(
      scheduledTaskSchema.parse({
        id: "task-1",
        agentId: "release-planner",
        title: "Weekly digest",
        prompt: "Summarize the latest activity.",
        recurrence: "weekly",
        minuteOfHour: 45,
        hourOfDay: 8,
        dayOfWeek: 1,
        timezone: "Australia/Sydney",
        enabled: true,
        notifyOnCompletion: true,
        sessionMode: "dedicated",
        createdAt: "2026-05-01T00:00:00.000Z",
        updatedAt: "2026-05-01T00:00:00.000Z",
        nextRunAt: "2026-05-05T22:45:00.000Z",
        recentRuns: [],
      })
    ).toMatchObject({
      recurrence: "weekly",
      dayOfWeek: 1,
    });
  });

  it("rejects recurrence combinations that omit required fields", () => {
    expect(() =>
      scheduledTaskCreateSchema.parse({
        agentId: "release-planner",
        title: "Broken daily task",
        prompt: "Summarize the latest activity.",
        recurrence: "daily",
        minuteOfHour: 15,
        timezone: "Australia/Sydney",
        enabled: true,
        notifyOnCompletion: true,
        sessionMode: "dedicated",
      })
    ).toThrow(/hour of day/i);

    expect(() =>
      scheduledTaskCreateSchema.parse({
        agentId: "release-planner",
        title: "Broken weekly task",
        prompt: "Summarize the latest activity.",
        recurrence: "weekly",
        minuteOfHour: 15,
        hourOfDay: 9,
        timezone: "Australia/Sydney",
        enabled: true,
        notifyOnCompletion: true,
        sessionMode: "dedicated",
      })
    ).toThrow(/day of week/i);
  });
});

describe("LLM stats normalization", () => {
  it("clamps negative durations before parsing persisted usage metrics", () => {
    expect(
      normalizeLlmRequestStats({
        recordedAt: "2026-05-09T00:00:00.000Z",
        model: "google/gemma-3-4b",
        requestCount: 1,
        inputTokens: 12,
        outputTokens: 6,
        durationMs: -25,
        tokensPerSecond: -1,
      })
    ).toEqual({
      recordedAt: "2026-05-09T00:00:00.000Z",
      model: "google/gemma-3-4b",
      requestCount: 1,
      inputTokens: 12,
      outputTokens: 6,
      durationMs: 0,
      tokensPerSecond: 0,
    });
  });

  describe("speech schemas", () => {
    it("accepts the extended min-speech-service health payload", () => {
      expect(
        speechHealthSchema.parse({
          ok: true,
          provider: "openai-compatible",
          upstreamOk: true,
          upstreamBaseUrl: "http://127.0.0.1:8000",
          sttModel: "Systran/faster-distil-whisper-small.en",
          ttsModel: "speaches-ai/Kokoro-82M-v1.0-ONNX",
          defaultVoice: "af_heart",
          nlpModel: "gemma-4-e4b",
          nlpUpstreamOk: true,
          nlpUpstreamBaseUrl: "http://127.0.0.1:1234",
        })
      ).toMatchObject({
        nlpModel: "gemma-4-e4b",
        nlpUpstreamOk: true,
      });
    });

    it("parses speech capabilities that advertise text processing", () => {
      expect(
        speechCapabilitiesSchema.parse({
          provider: "openai-compatible",
          upstreamBaseUrl: "http://127.0.0.1:8000",
          transcription: {
            endpoint: "/v1/audio/transcriptions",
            model: "Systran/faster-distil-whisper-small.en",
            responseFormats: ["text", "json"],
          },
          synthesis: {
            endpoint: "/v1/audio/speech",
            model: "speaches-ai/Kokoro-82M-v1.0-ONNX",
            defaultVoice: "af_heart",
            responseFormats: ["wav"],
          },
          realtime: {
            supported: false,
          },
          textProcessing: {
            endpoint: "/v1/npl",
            model: "gemma-4-e4b",
            targetLanguage: "en",
            features: ["intent-detection", "translation"],
          },
        })
      ).toMatchObject({
        textProcessing: {
          model: "gemma-4-e4b",
          targetLanguage: "en",
        },
      });
    });

    it("parses text-processing results from min-speech-service", () => {
      expect(
        textProcessingResultSchema.parse({
          sourceText: "um can you email the summary",
          detectedLanguage: "en",
          intent: "Ask to email the summary",
          cleanedText: "can you email the summary",
          rewrittenText: "Can you email the summary?",
          translatedText: "Can you email the summary?",
          targetLanguage: "en",
          fillerWords: ["um"],
          model: "gemma-4-e4b",
          provider: "openai-compatible",
          raw: {
            detectedLanguage: "en",
          },
        })
      ).toMatchObject({
        intent: "Ask to email the summary",
        fillerWords: ["um"],
      });
    });
  });

  it("clamps negative persisted session totals before exposing them to the app", () => {
    expect(
      normalizeLlmSessionStats({
        requestCount: 2,
        inputTokens: 24,
        outputTokens: 12,
        totalDurationMs: -90,
        lastRecordedAt: "2026-05-09T00:00:00.000Z",
        lastModel: "google/gemma-3-4b",
        lastTokensPerSecond: -3,
      })
    ).toEqual({
      requestCount: 2,
      inputTokens: 24,
      outputTokens: 12,
      totalDurationMs: 0,
      lastRecordedAt: "2026-05-09T00:00:00.000Z",
      lastModel: "google/gemma-3-4b",
      lastTokensPerSecond: 0,
    });
  });
});
