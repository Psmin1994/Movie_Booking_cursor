export class HttpError extends Error {
  readonly status: number;
  readonly data: unknown;
  readonly headers: Headers;

  constructor(status: number, data: unknown, headers: Headers, message?: string) {
    super(message ?? `HTTP ${status}`);
    this.name = "HttpError";
    this.status = status;
    this.data = data;
    this.headers = headers;
  }
}

export class NetworkError extends Error {
  readonly cause?: unknown;

  constructor(message = "Network request failed", cause?: unknown) {
    super(message);
    this.name = "NetworkError";
    this.cause = cause;
  }
}

export class TimeoutError extends Error {
  readonly timeoutMs?: number;
  readonly cause?: unknown;

  constructor(message = "Request timed out", options?: { timeoutMs?: number; cause?: unknown }) {
    super(message);
    this.name = "TimeoutError";
    this.timeoutMs = options?.timeoutMs;
    this.cause = options?.cause;
  }
}

export class RequestCancelledError extends Error {
  readonly cause?: unknown;

  constructor(message = "Request was cancelled", cause?: unknown) {
    super(message);
    this.name = "RequestCancelledError";
    this.cause = cause;
  }
}

export function isHttpError(error: unknown): error is HttpError {
  return error instanceof HttpError;
}

export function isNetworkError(error: unknown): error is NetworkError {
  return error instanceof NetworkError;
}

export function isTimeoutError(error: unknown): error is TimeoutError {
  return error instanceof TimeoutError;
}

export function isRequestCancelledError(error: unknown): error is RequestCancelledError {
  return error instanceof RequestCancelledError;
}

export function extractErrorMessage(data: unknown, fallback: string): string {
  if (
    typeof data === "object" &&
    data !== null &&
    "message" in data &&
    (typeof data.message === "string" || Array.isArray(data.message))
  ) {
    return Array.isArray(data.message) ? data.message.join(", ") : data.message;
  }

  return fallback;
}

export function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") {
    return true;
  }

  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name: unknown }).name === "AbortError"
  );
}
