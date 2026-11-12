export function applyFetchInit(options: RequestInit): RequestInit {
  return {
    ...options,
    credentials: options.credentials ?? "include",
  };
}
