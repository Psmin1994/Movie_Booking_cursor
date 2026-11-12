import {
  isHttpError,
  isNetworkError,
  isTimeoutError,
} from "@movie-booking/api-client";

export function defaultQueryRetry(failureCount: number, error: unknown): boolean {
  if (failureCount >= 1) {
    return false;
  }

  if (isNetworkError(error) || isTimeoutError(error)) {
    return true;
  }

  if (isHttpError(error) && error.status >= 500) {
    return true;
  }

  return false;
}
