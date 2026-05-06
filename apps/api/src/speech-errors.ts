import {
  type SpeechHealth,
  speechHealthSchema,
} from "@gemma-agent-pwa/contracts";

interface SpeechHealthStatus {
  health?: SpeechHealth;
  issue?: string;
}

interface ErrorRecord extends Record<string, unknown> {
  cause?: unknown;
}

export function createSpeechFetchFailureResponse(
  actionLabel: string,
  baseUrl: string,
  error: unknown
): Response {
  return new Response(
    JSON.stringify({
      error: describeSpeechFetchFailure(actionLabel, baseUrl, error),
    }),
    {
      headers: {
        "content-type": "application/json",
      },
      status: 503,
      statusText: "Service Unavailable",
    }
  );
}

export function describeSpeechFetchFailure(
  actionLabel: string,
  baseUrl: string,
  error: unknown
): string {
  const transportDetail = getSpeechTransportDetail(error);
  return `${actionLabel} because min-speech-service at ${baseUrl} is unreachable${transportDetail ? ` (${transportDetail})` : ""}. Start min-speech-service or update MIN_SPEECH_SERVICE_URL.`;
}

export async function forwardSpeechUpstreamError(
  response: Response,
  actionLabel: string,
  baseUrl: string
): Promise<Response> {
  const errorMessage = await readSpeechUpstreamError(
    response,
    actionLabel,
    baseUrl
  );

  return new Response(JSON.stringify({ error: errorMessage }), {
    headers: {
      "content-type": "application/json",
    },
    status: response.status,
    statusText: response.statusText,
  });
}

export async function getSpeechHealthStatus(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch
): Promise<SpeechHealthStatus> {
  try {
    const response = await fetchImpl(`${baseUrl}/health`);
    if (!response.ok) {
      return {
        issue: await readSpeechUpstreamError(
          response,
          "Speech is unavailable",
          baseUrl
        ),
      };
    }
    const health = speechHealthSchema.parse(await response.json());
    return {
      health,
      ...(!health.ok
        ? {
            issue:
              health.detail?.trim() ||
              `Speech is unavailable because min-speech-service at ${baseUrl} reported an unhealthy state.`,
          }
        : {}),
    };
  } catch (error) {
    return {
      issue: describeSpeechFetchFailure(
        "Speech is unavailable",
        baseUrl,
        error
      ),
    };
  }
}

async function readSpeechUpstreamError(
  response: Response,
  actionLabel: string,
  baseUrl: string
): Promise<string> {
  const responseText = (await response.text()).trim();
  if (responseText && isJsonResponse(response)) {
    const payload = parseJsonRecord(responseText);
    const message = readSpeechPayloadMessage(payload);
    if (message) {
      return message;
    }
  }

  if (responseText) {
    return responseText;
  }

  const statusDetail = [response.status, response.statusText]
    .filter(Boolean)
    .join(" ");
  return `${actionLabel} because min-speech-service at ${baseUrl} returned ${statusDetail || "an error response"}.`;
}

function getSpeechTransportDetail(error: unknown): string | undefined {
  const record = toErrorRecord(error);
  const cause = toErrorRecord(record?.cause);
  const errorMessage = readErrorMessage(error);
  const causeMessage = readErrorMessage(record?.cause);
  const code = readString(cause?.code) ?? readString(record?.code);
  const address = readString(cause?.address);
  const port = readNumber(cause?.port);
  const addressPort = formatAddressPort(address, port);

  switch (code) {
    case "ECONNREFUSED":
      return addressPort
        ? `connection to ${addressPort} was refused`
        : "the connection was refused";
    case "ENOTFOUND":
      return address
        ? `host ${address} could not be resolved`
        : "the host could not be resolved";
    case "ECONNRESET":
      return "the connection was reset";
    case "ETIMEDOUT":
    case "UND_ERR_CONNECT_TIMEOUT":
      return addressPort
        ? `connection to ${addressPort} timed out`
        : "the connection timed out";
  }

  if (causeMessage) {
    return causeMessage;
  }
  if (errorMessage && errorMessage !== "fetch failed") {
    return errorMessage;
  }
  return undefined;
}

function readSpeechPayloadMessage(
  payload: Record<string, unknown> | undefined
): string | undefined {
  if (!payload) {
    return undefined;
  }
  if (typeof payload.error === "string" && payload.error.trim()) {
    return payload.error;
  }
  if (
    payload.error &&
    typeof payload.error === "object" &&
    !Array.isArray(payload.error) &&
    typeof (payload.error as { message?: unknown }).message === "string" &&
    (payload.error as { message: string }).message.trim()
  ) {
    return (payload.error as { message: string }).message;
  }
  if (typeof payload.message === "string" && payload.message.trim()) {
    return payload.message;
  }
  return undefined;
}

function isJsonResponse(response: Response): boolean {
  return (
    response.headers.get("content-type")?.toLowerCase().includes("json") ??
    false
  );
}

function parseJsonRecord(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch (error) {
    if (error instanceof SyntaxError) {
      return undefined;
    }
    throw error;
  }
}

function toErrorRecord(value: unknown): ErrorRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as ErrorRecord)
    : undefined;
}

function readErrorMessage(value: unknown): string | undefined {
  return value instanceof Error && value.message.trim()
    ? value.message
    : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function formatAddressPort(
  address: string | undefined,
  port: number | undefined
): string | undefined {
  if (address && typeof port === "number") {
    return `${address}:${port}`;
  }
  return address;
}
