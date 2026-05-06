import { describe, expect, it } from "vitest";
import {
  createSpeechFetchFailureResponse,
  describeSpeechFetchFailure,
  forwardSpeechUpstreamError,
  getSpeechHealthStatus,
} from "./speech-errors.js";

describe("speech error helpers", () => {
  it("describes transport failures with the speech service address", () => {
    const error = new TypeError("fetch failed", {
      cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8790"), {
        address: "127.0.0.1",
        code: "ECONNREFUSED",
        port: 8790,
      }),
    });

    expect(
      describeSpeechFetchFailure(
        "Speech synthesis failed",
        "http://127.0.0.1:8790",
        error
      )
    ).toBe(
      "Speech synthesis failed because min-speech-service at http://127.0.0.1:8790 is unreachable (connection to 127.0.0.1:8790 was refused). Start min-speech-service or update MIN_SPEECH_SERVICE_URL."
    );
  });

  it("preserves nested upstream JSON error messages", async () => {
    const forwarded = await forwardSpeechUpstreamError(
      new Response(
        JSON.stringify({
          error: {
            message: "No TTS model is configured in the speech backend.",
          },
        }),
        {
          status: 500,
          headers: {
            "content-type": "application/json",
          },
        }
      ),
      "Speech synthesis failed",
      "http://127.0.0.1:8790"
    );

    await expect(forwarded.json()).resolves.toEqual({
      error: "No TTS model is configured in the speech backend.",
    });
  });

  it("maps opaque upstream status errors to a gateway failure", async () => {
    const forwarded = await forwardSpeechUpstreamError(
      new Response("404 status code (no body)", {
        status: 500,
        headers: {
          "content-type": "text/plain",
        },
      }),
      "Speech synthesis failed",
      "http://127.0.0.1:8790"
    );

    expect(forwarded.status).toBe(502);
    await expect(forwarded.json()).resolves.toEqual({
      error:
        "Speech synthesis failed because min-speech-service at http://127.0.0.1:8790 could not complete the request with its configured speech backend (upstream returned 404 with no body). Check the configured speech backend route/model, or update min-speech-service.",
    });
  });

  it("maps opaque upstream JSON errors to a gateway failure", async () => {
    const forwarded = await forwardSpeechUpstreamError(
      new Response(
        JSON.stringify({
          error: "404 status code (no body)",
        }),
        {
          status: 500,
          headers: {
            "content-type": "application/json",
          },
        }
      ),
      "Speech synthesis failed",
      "http://127.0.0.1:8790"
    );

    expect(forwarded.status).toBe(502);
    await expect(forwarded.json()).resolves.toEqual({
      error:
        "Speech synthesis failed because min-speech-service at http://127.0.0.1:8790 could not complete the request with its configured speech backend (upstream returned 404 with no body). Check the configured speech backend route/model, or update min-speech-service.",
    });
  });

  it("returns a structured 503 response for local transport errors", async () => {
    const response = createSpeechFetchFailureResponse(
      "Speech transcription failed",
      "http://127.0.0.1:8790",
      new TypeError("fetch failed")
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error:
        "Speech transcription failed because min-speech-service at http://127.0.0.1:8790 is unreachable. Start min-speech-service or update MIN_SPEECH_SERVICE_URL.",
    });
  });

  it("surfaces speech health issues from the service health payload", async () => {
    const status = await getSpeechHealthStatus(
      "http://127.0.0.1:8790",
      async () =>
        new Response(
          JSON.stringify({
            ok: false,
            provider: "openai-compatible",
            upstreamOk: false,
            upstreamBaseUrl: "http://127.0.0.1:8000",
            sttModel: "whisper-small",
            ttsModel: "kokoro",
            defaultVoice: "alloy",
            detail: "TTS upstream returned 404 for the configured model.",
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          }
        )
    );

    expect(status).toEqual({
      health: {
        ok: false,
        provider: "openai-compatible",
        upstreamOk: false,
        upstreamBaseUrl: "http://127.0.0.1:8000",
        sttModel: "whisper-small",
        ttsModel: "kokoro",
        defaultVoice: "alloy",
        detail: "TTS upstream returned 404 for the configured model.",
      },
      issue: "TTS upstream returned 404 for the configured model.",
    });
  });
});
