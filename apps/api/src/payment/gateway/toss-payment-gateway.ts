import {
  PaymentGateway,
  type PaymentGatewayCancelInput,
  type PaymentGatewayCancelResult,
  type PaymentGatewayConfirmInput,
  type PaymentGatewayConfirmResult,
  type PaymentGatewayRetrieveCancelOutcomeInput,
  type PaymentGatewayRetrieveCancelOutcomeResult,
  type PaymentGatewayRetrieveInput,
  type PaymentGatewayRetrieveResult,
} from "./payment-gateway.js";

const TOSS_CONFIRM_URL = "https://api.tosspayments.com/v1/payments/confirm";
const TOSS_RETRIEVE_URL = "https://api.tosspayments.com/v1/payments";
const TOSS_REQUEST_TIMEOUT_MS = 10_000;

const CONFIRMED_PAYMENT_FAILURE_CODES = new Set([
  "INVALID_REJECT_CARD",
  "NOT_ALLOWED_POINT_USE",
  "REJECT_ACCOUNT_PAYMENT",
  "REJECT_CARD_PAYMENT",
  "REJECT_CARD_COMPANY",
]);

const ALREADY_CANCELED_PAYMENT_CODE = "ALREADY_CANCELED_PAYMENT";
const IDEMPOTENT_REQUEST_PROCESSING_CODE = "IDEMPOTENT_REQUEST_PROCESSING";

const CONFIRMED_CANCEL_FAILURE_CODES = new Set([
  "NOT_CANCELABLE_PAYMENT",
  "NOT_CANCELABLE_AMOUNT",
  "REFUND_REJECTED",
  "INVALID_REFUND_ACCOUNT_INFO",
  "NOT_ALLOWED_PARTIAL_REFUND",
  "EXCEED_MAX_REFUND_AMOUNT",
  "NOT_FOUND_PAYMENT",
]);

const CANCEL_SUCCESS_PAYMENT_STATUS = "CANCELED";

type FetchLike = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

type PaidPaymentFields = {
  paymentKey: string;
  orderId: string;
  amount: number;
  approvedAt: Date;
};

type MatchedCancel = {
  transactionKey: string;
  cancelAmount: number;
};

export class TossPaymentGateway extends PaymentGateway {
  constructor(
    private readonly secretKey: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    super();
  }

  async confirm(
    input: PaymentGatewayConfirmInput,
  ): Promise<PaymentGatewayConfirmResult> {
    if (this.secretKey.trim().length === 0) {
      return confirmUnknown();
    }

    try {
      const response = await this.fetchImpl(TOSS_CONFIRM_URL, {
        method: "POST",
        headers: {
          Authorization: authorizationHeader(this.secretKey),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          paymentKey: input.paymentKey,
          orderId: input.orderId,
          amount: input.amount,
        }),
        signal: AbortSignal.timeout(TOSS_REQUEST_TIMEOUT_MS),
      });
      const body = await readJson(response);

      return classifyConfirmResponse(response.ok, body);
    } catch {
      return confirmUnknown();
    }
  }

  async retrieve(input: PaymentGatewayRetrieveInput): Promise<PaymentGatewayRetrieveResult> {
    if (this.secretKey.trim().length === 0) {
      return retrieveUnknown();
    }

    try {
      const response = await this.fetchImpl(retrieveUrl(input.paymentKey), {
        method: "GET",
        headers: {
          Authorization: authorizationHeader(this.secretKey),
        },
        signal: AbortSignal.timeout(TOSS_REQUEST_TIMEOUT_MS),
      });
      const body = await readJson(response);

      return classifyRetrieveResponse(response.ok, body, input.paymentKey);
    } catch {
      return retrieveUnknown();
    }
  }

  async cancel(input: PaymentGatewayCancelInput): Promise<PaymentGatewayCancelResult> {
    if (this.secretKey.trim().length === 0) {
      return cancelUnknown();
    }

    try {
      const response = await this.fetchImpl(cancelUrl(input.paymentKey), {
        method: "POST",
        headers: {
          Authorization: authorizationHeader(this.secretKey),
          "Content-Type": "application/json",
          "Idempotency-Key": input.idempotencyKey,
        },
        body: JSON.stringify({
          cancelReason: input.cancelReason,
          cancelAmount: input.cancelAmount,
        }),
        signal: AbortSignal.timeout(TOSS_REQUEST_TIMEOUT_MS),
      });
      const body = await readJson(response);

      return classifyCancelResponse(response.ok, body, input);
    } catch {
      return cancelUnknown();
    }
  }

  async retrieveCancelOutcome(
    input: PaymentGatewayRetrieveCancelOutcomeInput,
  ): Promise<PaymentGatewayRetrieveCancelOutcomeResult> {
    if (this.secretKey.trim().length === 0) {
      return retrieveCancelUnknown();
    }

    try {
      const response = await this.fetchImpl(retrieveUrl(input.paymentKey), {
        method: "GET",
        headers: {
          Authorization: authorizationHeader(this.secretKey),
        },
        signal: AbortSignal.timeout(TOSS_REQUEST_TIMEOUT_MS),
      });
      const body = await readJson(response);

      return classifyRetrieveCancelOutcomeResponse(response.ok, body, input);
    } catch {
      return retrieveCancelUnknown();
    }
  }
}

function retrieveUrl(paymentKey: string): string {
  return `${TOSS_RETRIEVE_URL}/${encodeURIComponent(paymentKey)}`;
}

function cancelUrl(paymentKey: string): string {
  return `${retrieveUrl(paymentKey)}/cancel`;
}

export function authorizationHeader(secretKey: string): string {
  return `Basic ${Buffer.from(`${secretKey}:`).toString("base64")}`;
}

function classifyConfirmResponse(
  ok: boolean,
  body: unknown,
): PaymentGatewayConfirmResult {
  const payment = asRecord(body);

  if (ok && payment?.status === "DONE") {
    const paid = toPaidPaymentFields(payment);
    if (paid) {
      return {
        status: "SUCCESS",
        ...paid,
      };
    }
  }

  if (payment?.status === "ABORTED") {
    return confirmFailed();
  }

  const code = errorCode(body);
  if (code !== null && CONFIRMED_PAYMENT_FAILURE_CODES.has(code)) {
    return confirmFailed();
  }

  return confirmUnknown();
}

function classifyRetrieveResponse(
  ok: boolean,
  body: unknown,
  paymentKey: string,
): PaymentGatewayRetrieveResult {
  if (!ok) {
    return retrieveUnknown();
  }

  const payment = asRecord(body);
  if (
    payment === null ||
    typeof payment.paymentKey !== "string" ||
    payment.paymentKey !== paymentKey
  ) {
    return retrieveUnknown();
  }

  if (payment.status === "DONE") {
    const paid = toPaidPaymentFields(payment);
    if (paid) {
      return {
        status: "PAID",
        ...paid,
      };
    }

    return retrieveUnknown();
  }

  if (payment.status === "ABORTED") {
    return retrieveNotPaid();
  }

  if (payment.status === "EXPIRED") {
    return retrieveNotPaid();
  }

  return retrieveUnknown();
}

function classifyCancelResponse(
  ok: boolean,
  body: unknown,
  input: PaymentGatewayCancelInput,
): PaymentGatewayCancelResult {
  const code = errorCode(body);

  if (code === ALREADY_CANCELED_PAYMENT_CODE) {
    return cancelUnknown();
  }

  if (code === IDEMPOTENT_REQUEST_PROCESSING_CODE) {
    return cancelUnknown();
  }

  if (code !== null && CONFIRMED_CANCEL_FAILURE_CODES.has(code)) {
    return { status: "FAILED" };
  }

  if (!ok) {
    return cancelUnknown();
  }

  const payment = asRecord(body);
  if (
    payment === null ||
    typeof payment.paymentKey !== "string" ||
    payment.paymentKey !== input.paymentKey ||
    payment.status !== CANCEL_SUCCESS_PAYMENT_STATUS
  ) {
    // PARTIAL_CANCELED and any other status stay UNKNOWN — full-amount cancel only.
    return cancelUnknown();
  }

  const matched = matchCancelByLastTransactionKey(payment, input.cancelAmount);
  if (matched === null) {
    return cancelUnknown();
  }

  return {
    status: "SUCCESS",
    paymentKey: input.paymentKey,
    cancelAmount: matched.cancelAmount,
    transactionKey: matched.transactionKey,
  };
}

/**
 * Official Toss docs: after a cancel, Payment.lastTransactionKey is the latest
 * transaction key, and cancels[] entries each carry their own transactionKey.
 * SUCCESS only when lastTransactionKey identifies a DONE cancel with the requested amount.
 */
function matchCancelByLastTransactionKey(
  payment: Record<string, unknown>,
  cancelAmount: number,
): MatchedCancel | null {
  const lastTransactionKey = payment.lastTransactionKey;
  if (typeof lastTransactionKey !== "string" || lastTransactionKey.length === 0) {
    return null;
  }

  const cancel = findCancelByTransactionKey(payment.cancels, lastTransactionKey);
  if (cancel === null) {
    return null;
  }

  if (cancel.cancelStatus !== "DONE") {
    return null;
  }

  if (cancel.cancelAmount !== cancelAmount) {
    return null;
  }

  return {
    transactionKey: lastTransactionKey,
    cancelAmount: cancel.cancelAmount,
  };
}

function classifyRetrieveCancelOutcomeResponse(
  ok: boolean,
  body: unknown,
  input: PaymentGatewayRetrieveCancelOutcomeInput,
): PaymentGatewayRetrieveCancelOutcomeResult {
  if (!ok) {
    return retrieveCancelUnknown();
  }

  const payment = asRecord(body);
  if (
    payment === null ||
    typeof payment.paymentKey !== "string" ||
    payment.paymentKey !== input.paymentKey
  ) {
    return retrieveCancelUnknown();
  }

  if (payment.status === "PARTIAL_CANCELED") {
    return retrieveCancelUnknown();
  }

  const cancel = findCancelByTransactionKey(payment.cancels, input.transactionKey);
  if (cancel !== null) {
    if (payment.status !== CANCEL_SUCCESS_PAYMENT_STATUS) {
      return retrieveCancelUnknown();
    }

    if (cancel.cancelStatus !== "DONE") {
      return retrieveCancelUnknown();
    }

    if (cancel.cancelAmount !== input.cancelAmount) {
      return retrieveCancelUnknown();
    }

    return {
      status: "CANCELED",
      paymentKey: input.paymentKey,
      transactionKey: input.transactionKey,
      cancelAmount: cancel.cancelAmount,
    };
  }

  if (isFullyUncanceledPaidPayment(payment)) {
    return { status: "NOT_CANCELED" };
  }

  return retrieveCancelUnknown();
}

function findCancelByTransactionKey(
  cancels: unknown,
  transactionKey: string,
): { cancelAmount: number; cancelStatus: unknown } | null {
  if (!Array.isArray(cancels)) {
    return null;
  }

  const matches: { cancelAmount: number; cancelStatus: unknown }[] = [];

  for (const entry of cancels) {
    const record = asRecord(entry);
    if (record === null || record.transactionKey !== transactionKey) {
      continue;
    }

    if (typeof record.cancelAmount !== "number") {
      return null;
    }

    matches.push({
      cancelAmount: record.cancelAmount,
      cancelStatus: record.cancelStatus,
    });
  }

  if (matches.length !== 1) {
    return null;
  }

  return matches[0] ?? null;
}

function isFullyUncanceledPaidPayment(payment: Record<string, unknown>): boolean {
  if (payment.status !== "DONE") {
    return false;
  }

  if (typeof payment.totalAmount !== "number" || typeof payment.balanceAmount !== "number") {
    return false;
  }

  if (payment.balanceAmount !== payment.totalAmount) {
    return false;
  }

  if (payment.cancels == null) {
    return true;
  }

  if (!Array.isArray(payment.cancels)) {
    return false;
  }

  return payment.cancels.length === 0;
}

function confirmUnknown(): PaymentGatewayConfirmResult {
  return { status: "UNKNOWN" };
}

function confirmFailed(): PaymentGatewayConfirmResult {
  return { status: "FAILED" };
}

function retrieveUnknown(): PaymentGatewayRetrieveResult {
  return { status: "UNKNOWN" };
}

function retrieveNotPaid(): PaymentGatewayRetrieveResult {
  return { status: "NOT_PAID" };
}

function cancelUnknown(): PaymentGatewayCancelResult {
  return { status: "UNKNOWN" };
}

function retrieveCancelUnknown(): PaymentGatewayRetrieveCancelOutcomeResult {
  return { status: "UNKNOWN" };
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function asRecord(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== "object") {
    return null;
  }

  return body as Record<string, unknown>;
}

function errorCode(body: unknown): string | null {
  const record = asRecord(body);
  if (!record || !("code" in record)) {
    return null;
  }

  const code = record.code;
  return typeof code === "string" ? code : null;
}

function toPaidPaymentFields(
  payment: Record<string, unknown>,
): PaidPaymentFields | null {
  const approvedAt = parseApprovedAt(payment.approvedAt);

  if (
    typeof payment.paymentKey !== "string" ||
    typeof payment.orderId !== "string" ||
    typeof payment.totalAmount !== "number" ||
    !approvedAt
  ) {
    return null;
  }

  return {
    paymentKey: payment.paymentKey,
    orderId: payment.orderId,
    amount: payment.totalAmount,
    approvedAt,
  };
}

function parseApprovedAt(value: unknown): Date | null {
  if (typeof value !== "string") {
    return null;
  }

  const approvedAt = new Date(value);
  if (Number.isNaN(approvedAt.getTime())) {
    return null;
  }

  return approvedAt;
}
