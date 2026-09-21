export const MAX_REQUEST_BODY_BYTES = 64 * 1024;

const ALLOWED_WEB_ORIGINS = new Set([
  "https://msfthub.com",
  "https://www.msfthub.com",
]);

export class RequestBodyTooLargeError extends Error {
  constructor() {
    super("Request body exceeds the configured limit");
    this.name = "RequestBodyTooLargeError";
  }
}

export function isAllowedOrigin(
  origin: string | undefined,
  requestUrl: string,
): boolean {
  if (!origin) return true;

  try {
    const normalizedOrigin = new URL(origin).origin;
    return (
      normalizedOrigin === new URL(requestUrl).origin ||
      ALLOWED_WEB_ORIGINS.has(normalizedOrigin)
    );
  } catch {
    return false;
  }
}

export async function readLimitedJson(request: Request): Promise<unknown> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BODY_BYTES) {
    throw new RequestBodyTooLargeError();
  }

  const reader = request.body?.getReader();
  if (!reader) return JSON.parse("");

  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let text = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    size += value.byteLength;
    if (size > MAX_REQUEST_BODY_BYTES) {
      await reader.cancel();
      throw new RequestBodyTooLargeError();
    }
    text += decoder.decode(value, { stream: true });
  }

  text += decoder.decode();
  return JSON.parse(text);
}

interface LogDetails {
  requestId: string;
  httpMethod?: string;
  path?: string;
  status?: number;
  durationMs?: number;
  rpcMethod?: string;
  toolName?: string;
  errorName?: string;
  errorMessage?: string;
}

function redact(value: string): string {
  return value
    .replace(/(bearer\s+)[^\s"']+/gi, "$1[REDACTED]")
    .replace(
      /((?:api[_-]?key|authorization|password|secret|token)\s*[=:]\s*)[^\s,;]+/gi,
      "$1[REDACTED]",
    )
    .slice(0, 500);
}

export function logEvent(
  level: "info" | "warn" | "error",
  event: string,
  details: LogDetails,
): void {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...details,
    ...(details.errorMessage
      ? { errorMessage: redact(details.errorMessage) }
      : {}),
  };
  console[level](JSON.stringify(entry));
}
