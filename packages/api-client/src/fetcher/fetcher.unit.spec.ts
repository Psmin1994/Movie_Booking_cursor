import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import {
  HttpError,
  isHttpError,
  isNetworkError,
  isRequestCancelledError,
  isTimeoutError,
  NetworkError,
  RequestCancelledError,
  TimeoutError,
} from "./errors.js";
import { configureFetcher, fetcher } from "./fetcher.js";

function jsonResponse(status: number, body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
}

describe("fetcher", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    configureFetcher({});
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    configureFetcher({});
    jest.restoreAllMocks();
  });

  it("returns data, status, and headers for a successful JSON response", async () => {
    globalThis.fetch = (async () =>
      jsonResponse(200, { id: "booking-1" })) as typeof fetch;

    const result = await fetcher("/api/bookings/1");

    expect(result.status).toBe(200);
    expect(result.data).toEqual({ id: "booking-1" });
    expect(result.headers).toBeInstanceOf(Headers);
  });

  it("returns an empty object for 204 responses", async () => {
    globalThis.fetch = (async () =>
      new Response(null, { status: 204 })) as typeof fetch;

    const result = await fetcher("/api/bookings/1/cancel", { method: "POST" });

    expect(result.status).toBe(204);
    expect(result.data).toEqual({});
  });

  it("throws HttpError for HTTP 401", async () => {
    globalThis.fetch = (async () =>
      jsonResponse(401, {
        statusCode: 401,
        message: "인증이 필요합니다.",
        error: "Unauthorized",
      })) as typeof fetch;

    try {
      await fetcher("/api/bookings");
      throw new Error("expected HttpError");
    } catch (error) {
      expect(isHttpError(error)).toBe(true);
      expect(error).toBeInstanceOf(HttpError);
      if (isHttpError(error)) {
        expect(error.status).toBe(401);
        expect(error.message).toBe("인증이 필요합니다.");
        expect(error.data).toMatchObject({ message: "인증이 필요합니다." });
      }
      expect(isNetworkError(error)).toBe(false);
    }
  });

  it("throws HttpError for HTTP 404", async () => {
    globalThis.fetch = (async () =>
      jsonResponse(404, {
        statusCode: 404,
        message: "예매를 찾을 수 없습니다.",
        error: "Not Found",
      })) as typeof fetch;

    await expect(fetcher("/api/bookings/missing")).rejects.toMatchObject({
      name: "HttpError",
      status: 404,
      message: "예매를 찾을 수 없습니다.",
    });
  });

  it("throws HttpError for HTTP 409", async () => {
    globalThis.fetch = (async () =>
      jsonResponse(409, {
        statusCode: 409,
        message: "이미 예매된 좌석이 포함되어 있습니다.",
        error: "Conflict",
      })) as typeof fetch;

    await expect(fetcher("/api/bookings", { method: "POST" })).rejects.toMatchObject({
      name: "HttpError",
      status: 409,
      message: "이미 예매된 좌석이 포함되어 있습니다.",
    });
  });

  it("throws HttpError for HTTP 500 and does not classify it as NetworkError", async () => {
    globalThis.fetch = (async () =>
      jsonResponse(500, {
        statusCode: 500,
        message: "Internal Server Error",
        error: "Internal Server Error",
      })) as typeof fetch;

    try {
      await fetcher("/api/bookings");
      throw new Error("expected HttpError");
    } catch (error) {
      expect(isHttpError(error)).toBe(true);
      expect(isNetworkError(error)).toBe(false);
      if (isHttpError(error)) {
        expect(error.status).toBe(500);
      }
    }
  });

  it("throws NetworkError when fetch rejects with a non-abort error", async () => {
    const cause = new TypeError("Failed to fetch");
    globalThis.fetch = (async () => {
      throw cause;
    }) as typeof fetch;

    try {
      await fetcher("/api/bookings");
      throw new Error("expected NetworkError");
    } catch (error) {
      expect(error).toBeInstanceOf(NetworkError);
      expect(isNetworkError(error)).toBe(true);
      if (isNetworkError(error)) {
        expect(error.cause).toBe(cause);
      }
    }
  });

  it("throws TimeoutError when the configured timeout elapses", async () => {
    configureFetcher({ timeoutMs: 20 });

    globalThis.fetch = ((_, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            const abortError = new Error("Aborted");
            abortError.name = "AbortError";
            reject(abortError);
          },
          { once: true },
        );
      })) as typeof fetch;

    try {
      await fetcher("/api/bookings");
      throw new Error("expected TimeoutError");
    } catch (error) {
      expect(error).toBeInstanceOf(TimeoutError);
      expect(isTimeoutError(error)).toBe(true);
      expect(isNetworkError(error)).toBe(false);
      expect(isRequestCancelledError(error)).toBe(false);
      if (isTimeoutError(error)) {
        expect(error.timeoutMs).toBe(20);
      }
    }
  });

  it("throws RequestCancelledError for AbortError and does not classify it as NetworkError", async () => {
    const controller = new AbortController();
    controller.abort();

    globalThis.fetch = (async (_url, init) => {
      if (init?.signal?.aborted) {
        const abortError = new Error("Aborted");
        abortError.name = "AbortError";
        throw abortError;
      }

      return jsonResponse(200, {});
    }) as typeof fetch;

    try {
      await fetcher("/api/bookings", { signal: controller.signal });
      throw new Error("expected RequestCancelledError");
    } catch (error) {
      expect(error).toBeInstanceOf(RequestCancelledError);
      expect(isRequestCancelledError(error)).toBe(true);
      expect(isNetworkError(error)).toBe(false);
    }
  });

  it("throws HttpError with fallback message when an error body is not JSON", async () => {
    globalThis.fetch = (async () =>
      new Response("not-json", {
        status: 500,
        headers: { "Content-Type": "text/plain" },
      })) as typeof fetch;

    try {
      await fetcher("/api/bookings");
      throw new Error("expected HttpError");
    } catch (error) {
      expect(isHttpError(error)).toBe(true);
      if (isHttpError(error)) {
        expect(error.status).toBe(500);
        expect(error.data).toBeUndefined();
        expect(error.message).toBe("HTTP 500");
      }
    }
  });
});
