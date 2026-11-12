import { applyFetchInit } from "#fetcher-env";
import {
  extractErrorMessage,
  HttpError,
  isAbortError,
  NetworkError,
  RequestCancelledError,
  TimeoutError,
} from "./errors.js";

export interface FetcherConfig {
  baseUrl?: string;
  timeoutMs?: number;
}

type FetcherResponse = {
  data: unknown;
  status: number;
  headers: Headers;
};

let configuredBaseUrl: string | undefined;
let configuredTimeoutMs: number | undefined;

export function configureFetcher(config: FetcherConfig): void {
  configuredBaseUrl = config.baseUrl;
  configuredTimeoutMs = config.timeoutMs;
}

function readEnv(name: string): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env;

  return env?.[name];
}

function resolveBaseUrl(): string {
  if (configuredBaseUrl) {
    return configuredBaseUrl.replace(/\/+$/, "");
  }

  const envBaseUrl = readEnv("API_BASE_URL") ?? readEnv("NEXT_PUBLIC_API_URL");

  if (envBaseUrl) {
    return envBaseUrl.replace(/\/api\/?$/, "").replace(/\/+$/, "");
  }

  return "http://localhost:4100";
}

function resolveRequestUrl(url: string): string {
  if (/^https?:\/\//i.test(url)) {
    return url;
  }

  return `${resolveBaseUrl()}${url.startsWith("/") ? url : `/${url}`}`;
}

function parseBody(body: string | null): unknown {
  if (!body) {
    return {};
  }

  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

function createTimeoutSignal(
  timeoutMs: number,
  externalSignal?: AbortSignal,
): { signal: AbortSignal; cleanup: () => void; didTimeout: () => boolean } {
  const controller = new AbortController();
  let timedOut = false;

  const onExternalAbort = () => {
    controller.abort(externalSignal?.reason);
  };

  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort(externalSignal.reason);
    } else {
      externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }
  }

  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeoutId);
      externalSignal?.removeEventListener("abort", onExternalAbort);
    },
    didTimeout: () => timedOut,
  };
}

export async function fetcher<T extends FetcherResponse>(
  url: string,
  options: RequestInit = {},
): Promise<T> {
  const timeoutMs = configuredTimeoutMs;
  const timeout =
    typeof timeoutMs === "number" && timeoutMs > 0
      ? createTimeoutSignal(timeoutMs, options.signal ?? undefined)
      : undefined;

  const requestInit = applyFetchInit({
    ...options,
    signal: timeout?.signal ?? options.signal,
  });

  let response: Response;

  try {
    response = await fetch(resolveRequestUrl(url), requestInit);
  } catch (error) {
    timeout?.cleanup();

    if (timeout?.didTimeout()) {
      throw new TimeoutError("Request timed out", { timeoutMs, cause: error });
    }

    if (isAbortError(error) || options.signal?.aborted) {
      throw new RequestCancelledError("Request was cancelled", error);
    }

    throw new NetworkError("Network request failed", error);
  }

  timeout?.cleanup();

  const body = [204, 205, 304].includes(response.status)
    ? null
    : await response.text();

  const data = parseBody(body);

  if (response.status >= 400) {
    throw new HttpError(
      response.status,
      data,
      response.headers,
      extractErrorMessage(data, `HTTP ${response.status}`),
    );
  }

  // Successful responses with unparsable JSON still fail the contract.
  if (body && data === undefined) {
    throw new Error("Failed to parse response body");
  }

  return {
    data: data as T["data"],
    status: response.status,
    headers: response.headers,
  } as T;
}
