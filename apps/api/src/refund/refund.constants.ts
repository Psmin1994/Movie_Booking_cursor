export const REFUND_PENDING_STATUS = "PENDING";
export const REFUND_COMPLETED_STATUS = "COMPLETED";
export const REFUND_FAILED_STATUS = "FAILED";
export const REFUND_REVIEW_STATUS = "REVIEW";

export const REFUND_CANCEL_REASON = "예매 취소";

/** Toss cancel idempotency reuse window used by Worker expiry checks (168 hours). */
export const REFUND_CANCEL_IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Worker lease TTL covering Cancel + Retrieve outside the DB transaction. */
export const REFUND_LEASE_TTL_MS = 5 * 60 * 1000;

/** ProcessRefundScheduler batch size per cron run. */
export const PROCESS_REFUND_SCHEDULER_BATCH_LIMIT = 100;

/** ProcessRefundScheduler cron timezone. */
export const PROCESS_REFUND_SCHEDULER_TIMEZONE = "Asia/Seoul";

/** Daily 09:00, 12:00, 15:00 in PROCESS_REFUND_SCHEDULER_TIMEZONE (5-field cron). */
export const PROCESS_REFUND_SCHEDULER_CRON = "0 9,12,15 * * *";

export const PROCESS_REFUND_RESULT = {
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
  REVIEWED: "REVIEWED",
  PENDING: "PENDING",
  NOT_CLAIMED: "NOT_CLAIMED",
} as const;

export const CLAIM_REFUND_RESULT = {
  CLAIMED: "CLAIMED",
  NOT_CLAIMED: "NOT_CLAIMED",
} as const;

export const RELEASE_REFUND_LEASE_RESULT = {
  RELEASED: "RELEASED",
  NOT_FOUND: "NOT_FOUND",
  NOT_HELD: "NOT_HELD",
} as const;

export const WORKER_MARK_CANCEL_REQUESTED_AT_RESULT = {
  MARKED: "MARKED",
  ALREADY_SET: "ALREADY_SET",
  NOT_FOUND: "NOT_FOUND",
  NOT_PENDING: "NOT_PENDING",
  NOT_HELD: "NOT_HELD",
} as const;

export const WORKER_RECORD_TRANSACTION_KEY_RESULT = {
  RECORDED: "RECORDED",
  ALREADY_RECORDED: "ALREADY_RECORDED",
  KEY_CONFLICT: "KEY_CONFLICT",
  NOT_FOUND: "NOT_FOUND",
  NOT_PENDING: "NOT_PENDING",
  NOT_HELD: "NOT_HELD",
} as const;

export const WORKER_SETTLE_REFUND_RESULT = {
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
  REVIEWED: "REVIEWED",
  NOT_FOUND: "NOT_FOUND",
  NOT_PENDING: "NOT_PENDING",
  NOT_HELD: "NOT_HELD",
} as const;
