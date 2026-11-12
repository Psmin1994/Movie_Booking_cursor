const MINUTE_MS = 60 * 1000;

export const AUTOMATIC_RETRIEVE_INTERVAL_MS = 1 * MINUTE_MS;
export const AUTOMATIC_RETRY_DEADLINE_MS = 10 * MINUTE_MS;

export function nextAutomaticProcessAt(previousAt: Date): Date {
  return new Date(previousAt.getTime() + AUTOMATIC_RETRIEVE_INTERVAL_MS);
}

// PG 결과 조회 재시도 기한
export function automaticRetryDeadlineAt(createdAt: Date): Date {
  return new Date(createdAt.getTime() + AUTOMATIC_RETRY_DEADLINE_MS);
}
