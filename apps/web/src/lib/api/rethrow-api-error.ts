import {
  isHttpError,
  isNetworkError,
  isRequestCancelledError,
  isTimeoutError,
} from "@movie-booking/api-client";

export function rethrowApiError(error: unknown, fallbackMessage: string): never {
  if (
    isHttpError(error) ||
    isNetworkError(error) ||
    isTimeoutError(error) ||
    isRequestCancelledError(error)
  ) {
    throw error;
  }

  throw new Error(fallbackMessage);
}
