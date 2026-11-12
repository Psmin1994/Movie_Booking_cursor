/**
 * Test Intent:
 * 비밀키가 있을 때만 Toss 승인·조회·취소를 요청한다. Confirm은 DONE을 SUCCESS, ABORTED·확정 거절 코드를 FAILED로 분류한다.
 * Retrieve는 요청 paymentKey와 응답 paymentKey가 일치할 때만 DONE을 PAID, ABORTED·EXPIRED를 NOT_PAID로 분류한다.
 * paymentKey 불일치·누락·타입 오류·비객체 응답과 그 외 상태·오류·불완전 응답은 UNKNOWN이다.
 * Cancel은 Idempotency-Key를 보내고, status CANCELED + lastTransactionKey DONE cancel + 금액 일치일 때만 SUCCESS다.
 * PARTIAL_CANCELED·ALREADY_CANCELED_PAYMENT·IDEMPOTENT_REQUEST_PROCESSING·키/금액 문제는 SUCCESS가 아니다.
 * retrieveCancelOutcome은 GET payment로 전액 취소(CANCELED)만 CANCELED로 판정하고 PARTIAL_CANCELED는 UNKNOWN이다.
 */

import { jest } from "@jest/globals";
import {
  authorizationHeader,
  TossPaymentGateway,
} from "./toss-payment-gateway.js";

const SECRET_KEY = "test_sk_example";
const INPUT = {
  paymentKey: "pay-key",
  orderId: "ord_550e8400-e29b-41d4-a716-446655440031",
  amount: 10_000,
  idempotencyKey: "idem-550e8400-e29b-41d4-a716-446655440031",
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function gatewayWith(response: Response | Promise<Response>): TossPaymentGateway {
  const fetchImpl = jest.fn<typeof fetch>().mockImplementation(() => Promise.resolve(response));
  return new TossPaymentGateway(SECRET_KEY, fetchImpl);
}

describe("TossPaymentGateway", () => {
  it("builds a Basic authorization header from the secret key and a colon", () => {
    expect(authorizationHeader(SECRET_KEY)).toBe(
      `Basic ${Buffer.from(`${SECRET_KEY}:`).toString("base64")}`,
    );
  });

  it("confirms with paymentKey, orderId, and amount when Toss status is DONE", async () => {
    const fetchImpl = jest.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(200, {
        status: "DONE",
        paymentKey: INPUT.paymentKey,
        orderId: INPUT.orderId,
        totalAmount: INPUT.amount,
        approvedAt: "2026-09-25T10:00:00.000Z",
      }),
    );
    const gateway = new TossPaymentGateway(SECRET_KEY, fetchImpl);

    const confirmInput = {
      paymentKey: INPUT.paymentKey,
      orderId: INPUT.orderId,
      amount: INPUT.amount,
    };

    await expect(gateway.confirm(confirmInput)).resolves.toEqual({
      status: "SUCCESS",
      paymentKey: INPUT.paymentKey,
      orderId: INPUT.orderId,
      amount: INPUT.amount,
      approvedAt: new Date("2026-09-25T10:00:00.000Z"),
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.tosspayments.com/v1/payments/confirm",
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: authorizationHeader(SECRET_KEY),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(confirmInput),
      }),
    );
  });

  it("maps an aborted payment object to FAILED", async () => {
    const gateway = gatewayWith(
      jsonResponse(200, {
        status: "ABORTED",
        paymentKey: INPUT.paymentKey,
        orderId: INPUT.orderId,
        totalAmount: INPUT.amount,
      }),
    );

    await expect(gateway.confirm(INPUT)).resolves.toEqual({ status: "FAILED" });
  });

  it.each([
    ["INVALID_REJECT_CARD", 400],
    ["NOT_ALLOWED_POINT_USE", 400],
    ["REJECT_ACCOUNT_PAYMENT", 403],
    ["REJECT_CARD_PAYMENT", 403],
    ["REJECT_CARD_COMPANY", 403],
  ])("maps confirmed decline %s to FAILED", async (code, status) => {
    const gateway = gatewayWith(
      jsonResponse(status, {
        code,
        message: "결제 승인이 거절되었습니다.",
      }),
    );

    await expect(gateway.confirm(INPUT)).resolves.toEqual({ status: "FAILED" });
  });

  it.each([
    "ALREADY_PROCESSED_PAYMENT",
    "ALREADY_PROCESSING_REQUEST",
    "PROVIDER_ERROR",
    "INVALID_REQUEST",
    "NOT_FOUND_PAYMENT",
    "NOT_FOUND_PAYMENT_SESSION",
    "UNAPPROVED_ORDER_ID",
  ])("maps %s to UNKNOWN", async (code) => {
    const gateway = gatewayWith(
      jsonResponse(400, {
        code,
        message: "결과를 확정할 수 없습니다.",
      }),
    );

    await expect(gateway.confirm(INPUT)).resolves.toEqual({ status: "UNKNOWN" });
  });

  it.each([
    "FORBIDDEN_REQUEST",
    "FDS_ERROR",
  ])("maps 403 %s to UNKNOWN", async (code) => {
    const gateway = gatewayWith(
      jsonResponse(403, {
        code,
        message: "결과를 확정할 수 없습니다.",
      }),
    );

    await expect(gateway.confirm(INPUT)).resolves.toEqual({ status: "UNKNOWN" });
  });

  it.each([
    "UNAUTHORIZED_KEY",
    "INVALID_API_KEY",
    "INCORRECT_BASIC_AUTH_FORMAT",
  ])("maps auth error %s to UNKNOWN", async (code) => {
    const gateway = gatewayWith(
      jsonResponse(401, {
        code,
        message: "인증에 실패했습니다.",
      }),
    );

    await expect(gateway.confirm(INPUT)).resolves.toEqual({ status: "UNKNOWN" });
  });

  it.each([
    "FAILED_PAYMENT_INTERNAL_SYSTEM_PROCESSING",
    "FAILED_INTERNAL_SYSTEM_PROCESSING",
    "UNKNOWN_PAYMENT_ERROR",
  ])("maps 5xx %s to UNKNOWN", async (code) => {
    const gateway = gatewayWith(
      jsonResponse(500, {
        code,
        message: "일시적인 오류입니다.",
      }),
    );

    await expect(gateway.confirm(INPUT)).resolves.toEqual({ status: "UNKNOWN" });
  });

  it("maps an unknown Toss error code to UNKNOWN", async () => {
    const gateway = gatewayWith(
      jsonResponse(400, {
        code: "SOME_UNLISTED_ERROR",
        message: "알 수 없는 오류입니다.",
      }),
    );

    await expect(gateway.confirm(INPUT)).resolves.toEqual({ status: "UNKNOWN" });
  });

  it("maps a non-DONE payment status to UNKNOWN", async () => {
    const gateway = gatewayWith(
      jsonResponse(200, {
        status: "IN_PROGRESS",
        paymentKey: INPUT.paymentKey,
        orderId: INPUT.orderId,
        totalAmount: INPUT.amount,
      }),
    );

    await expect(gateway.confirm(INPUT)).resolves.toEqual({ status: "UNKNOWN" });
  });

  it("maps a DONE body with missing approval fields to UNKNOWN", async () => {
    const gateway = gatewayWith(
      jsonResponse(200, {
        status: "DONE",
        paymentKey: INPUT.paymentKey,
      }),
    );

    await expect(gateway.confirm(INPUT)).resolves.toEqual({ status: "UNKNOWN" });
  });

  it("maps invalid JSON to UNKNOWN", async () => {
    const fetchImpl = jest.fn<typeof fetch>().mockResolvedValue(
      new Response("not-json", { status: 200 }),
    );
    const gateway = new TossPaymentGateway(SECRET_KEY, fetchImpl);

    await expect(gateway.confirm(INPUT)).resolves.toEqual({ status: "UNKNOWN" });
  });

  it("does not call Toss when the secret key is blank", async () => {
    const fetchImpl = jest.fn<typeof fetch>();
    const gateway = new TossPaymentGateway("   ", fetchImpl);

    await expect(gateway.confirm(INPUT)).resolves.toEqual({ status: "UNKNOWN" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maps timeout to UNKNOWN", async () => {
    const fetchImpl = jest
      .fn<typeof fetch>()
      .mockRejectedValue(new DOMException("timed out", "TimeoutError"));
    const gateway = new TossPaymentGateway(SECRET_KEY, fetchImpl);

    await expect(gateway.confirm(INPUT)).resolves.toEqual({ status: "UNKNOWN" });
  });

  it("maps a network error to UNKNOWN", async () => {
    const fetchImpl = jest
      .fn<typeof fetch>()
      .mockRejectedValue(new TypeError("network error"));
    const gateway = new TossPaymentGateway(SECRET_KEY, fetchImpl);

    await expect(gateway.confirm(INPUT)).resolves.toEqual({ status: "UNKNOWN" });
  });

  it("retrieves a payment by paymentKey when Toss status is DONE", async () => {
    const fetchImpl = jest.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(200, {
        status: "DONE",
        paymentKey: INPUT.paymentKey,
        orderId: INPUT.orderId,
        totalAmount: INPUT.amount,
        approvedAt: "2026-09-25T10:00:00.000Z",
      }),
    );
    const gateway = new TossPaymentGateway(SECRET_KEY, fetchImpl);

    await expect(gateway.retrieve({ paymentKey: INPUT.paymentKey })).resolves.toEqual({
      status: "PAID",
      paymentKey: INPUT.paymentKey,
      orderId: INPUT.orderId,
      amount: INPUT.amount,
      approvedAt: new Date("2026-09-25T10:00:00.000Z"),
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      `https://api.tosspayments.com/v1/payments/${encodeURIComponent(INPUT.paymentKey)}`,
      expect.objectContaining({
        method: "GET",
        headers: {
          Authorization: authorizationHeader(SECRET_KEY),
        },
      }),
    );
  });

  it("maps an aborted retrieved payment to NOT_PAID", async () => {
    const gateway = gatewayWith(
      jsonResponse(200, {
        status: "ABORTED",
        paymentKey: INPUT.paymentKey,
        orderId: INPUT.orderId,
        totalAmount: INPUT.amount,
      }),
    );

    await expect(gateway.retrieve({ paymentKey: INPUT.paymentKey })).resolves.toEqual({
      status: "NOT_PAID",
    });
  });

  it("maps an expired retrieved payment to NOT_PAID", async () => {
    const gateway = gatewayWith(
      jsonResponse(200, {
        status: "EXPIRED",
        paymentKey: INPUT.paymentKey,
        orderId: INPUT.orderId,
        totalAmount: INPUT.amount,
      }),
    );

    await expect(gateway.retrieve({ paymentKey: INPUT.paymentKey })).resolves.toEqual({
      status: "NOT_PAID",
    });
  });

  it.each(["DONE", "ABORTED", "EXPIRED"] as const)(
    "maps a retrieved %s payment with a mismatched paymentKey to UNKNOWN",
    async (status) => {
      const gateway = gatewayWith(
        jsonResponse(200, {
          status,
          paymentKey: "other-key",
          orderId: INPUT.orderId,
          totalAmount: INPUT.amount,
          approvedAt: "2026-09-25T10:00:00.000Z",
        }),
      );

      await expect(gateway.retrieve({ paymentKey: INPUT.paymentKey })).resolves.toEqual({
        status: "UNKNOWN",
      });
    },
  );

  it("maps a retrieved payment without a paymentKey to UNKNOWN", async () => {
    const gateway = gatewayWith(
      jsonResponse(200, {
        status: "ABORTED",
        orderId: INPUT.orderId,
        totalAmount: INPUT.amount,
      }),
    );

    await expect(gateway.retrieve({ paymentKey: INPUT.paymentKey })).resolves.toEqual({
      status: "UNKNOWN",
    });
  });

  it("maps a retrieved payment with a non-string paymentKey to UNKNOWN", async () => {
    const gateway = gatewayWith(
      jsonResponse(200, {
        status: "ABORTED",
        paymentKey: 12345,
        orderId: INPUT.orderId,
        totalAmount: INPUT.amount,
      }),
    );

    await expect(gateway.retrieve({ paymentKey: INPUT.paymentKey })).resolves.toEqual({
      status: "UNKNOWN",
    });
  });

  it("maps a non-object retrieve body to UNKNOWN", async () => {
    const gateway = gatewayWith(jsonResponse(200, "payment-object"));

    await expect(gateway.retrieve({ paymentKey: INPUT.paymentKey })).resolves.toEqual({
      status: "UNKNOWN",
    });
  });

  it.each(["READY", "IN_PROGRESS", "WAITING_FOR_DEPOSIT", "CANCELED", "PARTIAL_CANCELED"])(
    "maps a retrieved %s payment to UNKNOWN",
    async (status) => {
      const gateway = gatewayWith(
        jsonResponse(200, {
          status,
          paymentKey: INPUT.paymentKey,
          orderId: INPUT.orderId,
          totalAmount: INPUT.amount,
        }),
      );

      await expect(gateway.retrieve({ paymentKey: INPUT.paymentKey })).resolves.toEqual({
        status: "UNKNOWN",
      });
    },
  );

  it("maps an unknown retrieved payment status to UNKNOWN", async () => {
    const gateway = gatewayWith(
      jsonResponse(200, {
        status: "SOME_FUTURE_STATUS",
        paymentKey: INPUT.paymentKey,
        orderId: INPUT.orderId,
        totalAmount: INPUT.amount,
      }),
    );

    await expect(gateway.retrieve({ paymentKey: INPUT.paymentKey })).resolves.toEqual({
      status: "UNKNOWN",
    });
  });

  it("maps a retrieved DONE body with missing approval fields to UNKNOWN", async () => {
    const gateway = gatewayWith(
      jsonResponse(200, {
        status: "DONE",
        paymentKey: INPUT.paymentKey,
      }),
    );

    await expect(gateway.retrieve({ paymentKey: INPUT.paymentKey })).resolves.toEqual({
      status: "UNKNOWN",
    });
  });

  it("maps retrieve confirm-style decline codes to UNKNOWN", async () => {
    const gateway = gatewayWith(
      jsonResponse(400, {
        code: "REJECT_CARD_PAYMENT",
        message: "결제 승인이 거절되었습니다.",
      }),
    );

    await expect(gateway.retrieve({ paymentKey: INPUT.paymentKey })).resolves.toEqual({
      status: "UNKNOWN",
    });
  });

  it("maps retrieve NOT_FOUND_PAYMENT to UNKNOWN", async () => {
    const gateway = gatewayWith(
      jsonResponse(404, {
        code: "NOT_FOUND_PAYMENT",
        message: "존재하지 않는 결제 정보 입니다.",
      }),
    );

    await expect(gateway.retrieve({ paymentKey: INPUT.paymentKey })).resolves.toEqual({
      status: "UNKNOWN",
    });
  });

  it("maps invalid retrieve JSON to UNKNOWN", async () => {
    const fetchImpl = jest.fn<typeof fetch>().mockResolvedValue(
      new Response("not-json", { status: 200 }),
    );
    const gateway = new TossPaymentGateway(SECRET_KEY, fetchImpl);

    await expect(gateway.retrieve({ paymentKey: INPUT.paymentKey })).resolves.toEqual({
      status: "UNKNOWN",
    });
  });

  it("does not retrieve when the secret key is blank", async () => {
    const fetchImpl = jest.fn<typeof fetch>();
    const gateway = new TossPaymentGateway("   ", fetchImpl);

    await expect(gateway.retrieve({ paymentKey: INPUT.paymentKey })).resolves.toEqual({
      status: "UNKNOWN",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maps a retrieve network error to UNKNOWN", async () => {
    const fetchImpl = jest
      .fn<typeof fetch>()
      .mockRejectedValue(new TypeError("network error"));
    const gateway = new TossPaymentGateway(SECRET_KEY, fetchImpl);

    await expect(gateway.retrieve({ paymentKey: INPUT.paymentKey })).resolves.toEqual({
      status: "UNKNOWN",
    });
  });

  it("cancels with Idempotency-Key and extracts transactionKey from lastTransactionKey", async () => {
    const transactionKey = "txn-current-cancel";
    const fetchImpl = jest.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(200, {
        status: "CANCELED",
        paymentKey: INPUT.paymentKey,
        lastTransactionKey: transactionKey,
        cancels: [
          {
            cancelAmount: INPUT.amount,
            cancelStatus: "DONE",
            transactionKey,
          },
        ],
      }),
    );
    const gateway = new TossPaymentGateway(SECRET_KEY, fetchImpl);
    const input = {
      paymentKey: INPUT.paymentKey,
      cancelReason: "예매 취소",
      cancelAmount: INPUT.amount,
      idempotencyKey: INPUT.idempotencyKey,
    };

    await expect(gateway.cancel(input)).resolves.toEqual({
      status: "SUCCESS",
      paymentKey: INPUT.paymentKey,
      cancelAmount: INPUT.amount,
      transactionKey,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      `https://api.tosspayments.com/v1/payments/${INPUT.paymentKey}/cancel`,
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: authorizationHeader(SECRET_KEY),
          "Content-Type": "application/json",
          "Idempotency-Key": INPUT.idempotencyKey,
        },
        body: JSON.stringify({
          cancelReason: input.cancelReason,
          cancelAmount: input.cancelAmount,
        }),
      }),
    );
  });

  it("maps PARTIAL_CANCELED cancel responses to UNKNOWN even with matching transactionKey and amount", async () => {
    const transactionKey = "txn-partial";
    const gateway = gatewayWith(
      jsonResponse(200, {
        status: "PARTIAL_CANCELED",
        paymentKey: INPUT.paymentKey,
        lastTransactionKey: transactionKey,
        cancels: [
          {
            cancelAmount: INPUT.amount,
            cancelStatus: "DONE",
            transactionKey,
          },
        ],
      }),
    );

    await expect(
      gateway.cancel({
        paymentKey: INPUT.paymentKey,
        cancelReason: "예매 취소",
        cancelAmount: INPUT.amount,
        idempotencyKey: INPUT.idempotencyKey,
      }),
    ).resolves.toEqual({ status: "UNKNOWN" });
  });

  it("does not treat an older same-amount cancel as SUCCESS when lastTransactionKey differs", async () => {
    const gateway = gatewayWith(
      jsonResponse(200, {
        status: "CANCELED",
        paymentKey: INPUT.paymentKey,
        lastTransactionKey: "txn-other",
        cancels: [
          {
            cancelAmount: INPUT.amount,
            cancelStatus: "DONE",
            transactionKey: "txn-older-same-amount",
          },
          {
            cancelAmount: 1_000,
            cancelStatus: "DONE",
            transactionKey: "txn-other",
          },
        ],
      }),
    );

    await expect(
      gateway.cancel({
        paymentKey: INPUT.paymentKey,
        cancelReason: "예매 취소",
        cancelAmount: INPUT.amount,
        idempotencyKey: INPUT.idempotencyKey,
      }),
    ).resolves.toEqual({ status: "UNKNOWN" });
  });

  it("maps cancel when lastTransactionKey is missing from cancels to UNKNOWN", async () => {
    const gateway = gatewayWith(
      jsonResponse(200, {
        status: "CANCELED",
        paymentKey: INPUT.paymentKey,
        lastTransactionKey: "txn-missing-from-cancels",
        cancels: [
          {
            cancelAmount: INPUT.amount,
            cancelStatus: "DONE",
            transactionKey: "txn-other",
          },
        ],
      }),
    );

    await expect(
      gateway.cancel({
        paymentKey: INPUT.paymentKey,
        cancelReason: "예매 취소",
        cancelAmount: INPUT.amount,
        idempotencyKey: INPUT.idempotencyKey,
      }),
    ).resolves.toEqual({ status: "UNKNOWN" });
  });

  it("maps cancel when matched cancelStatus is not DONE to UNKNOWN", async () => {
    const gateway = gatewayWith(
      jsonResponse(200, {
        status: "CANCELED",
        paymentKey: INPUT.paymentKey,
        lastTransactionKey: "txn-current",
        cancels: [
          {
            cancelAmount: INPUT.amount,
            cancelStatus: "PENDING",
            transactionKey: "txn-current",
          },
        ],
      }),
    );

    await expect(
      gateway.cancel({
        paymentKey: INPUT.paymentKey,
        cancelReason: "예매 취소",
        cancelAmount: INPUT.amount,
        idempotencyKey: INPUT.idempotencyKey,
      }),
    ).resolves.toEqual({ status: "UNKNOWN" });
  });

  it("maps cancel when the same transactionKey appears twice to UNKNOWN", async () => {
    const gateway = gatewayWith(
      jsonResponse(200, {
        status: "CANCELED",
        paymentKey: INPUT.paymentKey,
        lastTransactionKey: "txn-dup",
        cancels: [
          {
            cancelAmount: INPUT.amount,
            cancelStatus: "DONE",
            transactionKey: "txn-dup",
          },
          {
            cancelAmount: INPUT.amount,
            cancelStatus: "DONE",
            transactionKey: "txn-dup",
          },
        ],
      }),
    );

    await expect(
      gateway.cancel({
        paymentKey: INPUT.paymentKey,
        cancelReason: "예매 취소",
        cancelAmount: INPUT.amount,
        idempotencyKey: INPUT.idempotencyKey,
      }),
    ).resolves.toEqual({ status: "UNKNOWN" });
  });

  it("does not cancel when the secret key is blank", async () => {
    const fetchImpl = jest.fn<typeof fetch>();
    const gateway = new TossPaymentGateway("   ", fetchImpl);

    await expect(
      gateway.cancel({
        paymentKey: INPUT.paymentKey,
        cancelReason: "예매 취소",
        cancelAmount: INPUT.amount,
        idempotencyKey: INPUT.idempotencyKey,
      }),
    ).resolves.toEqual({ status: "UNKNOWN" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maps a cancel timeout to UNKNOWN", async () => {
    const fetchImpl = jest.fn<typeof fetch>().mockImplementation(() => {
      const error = new Error("The operation was aborted due to timeout");
      error.name = "TimeoutError";
      return Promise.reject(error);
    });
    const gateway = new TossPaymentGateway(SECRET_KEY, fetchImpl);

    await expect(
      gateway.cancel({
        paymentKey: INPUT.paymentKey,
        cancelReason: "예매 취소",
        cancelAmount: INPUT.amount,
        idempotencyKey: INPUT.idempotencyKey,
      }),
    ).resolves.toEqual({ status: "UNKNOWN" });
  });

  it("maps cancel success without lastTransactionKey to UNKNOWN", async () => {
    const gateway = gatewayWith(
      jsonResponse(200, {
        status: "CANCELED",
        paymentKey: INPUT.paymentKey,
        cancels: [
          {
            cancelAmount: INPUT.amount,
            cancelStatus: "DONE",
            transactionKey: "txn-only-in-cancels",
          },
        ],
      }),
    );

    await expect(
      gateway.cancel({
        paymentKey: INPUT.paymentKey,
        cancelReason: "예매 취소",
        cancelAmount: INPUT.amount,
        idempotencyKey: INPUT.idempotencyKey,
      }),
    ).resolves.toEqual({ status: "UNKNOWN" });
  });

  it("maps amount mismatch on the lastTransactionKey cancel to UNKNOWN", async () => {
    const gateway = gatewayWith(
      jsonResponse(200, {
        status: "CANCELED",
        paymentKey: INPUT.paymentKey,
        lastTransactionKey: "txn-current",
        cancels: [
          {
            cancelAmount: INPUT.amount + 1,
            cancelStatus: "DONE",
            transactionKey: "txn-current",
          },
        ],
      }),
    );

    await expect(
      gateway.cancel({
        paymentKey: INPUT.paymentKey,
        cancelReason: "예매 취소",
        cancelAmount: INPUT.amount,
        idempotencyKey: INPUT.idempotencyKey,
      }),
    ).resolves.toEqual({ status: "UNKNOWN" });
  });

  it("does not treat ALREADY_CANCELED_PAYMENT as SUCCESS", async () => {
    const gateway = gatewayWith(
      jsonResponse(400, { code: "ALREADY_CANCELED_PAYMENT" }),
    );

    await expect(
      gateway.cancel({
        paymentKey: INPUT.paymentKey,
        cancelReason: "예매 취소",
        cancelAmount: INPUT.amount,
        idempotencyKey: INPUT.idempotencyKey,
      }),
    ).resolves.toEqual({ status: "UNKNOWN" });
  });

  it("maps IDEMPOTENT_REQUEST_PROCESSING to UNKNOWN", async () => {
    const gateway = gatewayWith(
      jsonResponse(409, { code: "IDEMPOTENT_REQUEST_PROCESSING" }),
    );

    await expect(
      gateway.cancel({
        paymentKey: INPUT.paymentKey,
        cancelReason: "예매 취소",
        cancelAmount: INPUT.amount,
        idempotencyKey: INPUT.idempotencyKey,
      }),
    ).resolves.toEqual({ status: "UNKNOWN" });
  });

  it("maps a rejected cancel to FAILED", async () => {
    const gateway = gatewayWith(jsonResponse(400, { code: "REFUND_REJECTED" }));

    await expect(
      gateway.cancel({
        paymentKey: INPUT.paymentKey,
        cancelReason: "예매 취소",
        cancelAmount: INPUT.amount,
        idempotencyKey: INPUT.idempotencyKey,
      }),
    ).resolves.toEqual({ status: "FAILED" });
  });

  it("maps a cancel for a different payment key to UNKNOWN", async () => {
    const gateway = gatewayWith(
      jsonResponse(200, {
        status: "CANCELED",
        paymentKey: "other-key",
        lastTransactionKey: "txn-current",
        cancels: [
          {
            cancelAmount: INPUT.amount,
            cancelStatus: "DONE",
            transactionKey: "txn-current",
          },
        ],
      }),
    );

    await expect(
      gateway.cancel({
        paymentKey: INPUT.paymentKey,
        cancelReason: "예매 취소",
        cancelAmount: INPUT.amount,
        idempotencyKey: INPUT.idempotencyKey,
      }),
    ).resolves.toEqual({ status: "UNKNOWN" });
  });

  it("maps a cancel network error to UNKNOWN", async () => {
    const fetchImpl = jest.fn<typeof fetch>().mockRejectedValue(new TypeError("network error"));
    const gateway = new TossPaymentGateway(SECRET_KEY, fetchImpl);

    await expect(
      gateway.cancel({
        paymentKey: INPUT.paymentKey,
        cancelReason: "예매 취소",
        cancelAmount: INPUT.amount,
        idempotencyKey: INPUT.idempotencyKey,
      }),
    ).resolves.toEqual({ status: "UNKNOWN" });
  });

  it("maps retrieveCancelOutcome to CANCELED for matching DONE cancel", async () => {
    const transactionKey = "txn-target";
    const fetchImpl = jest.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(200, {
        status: "CANCELED",
        paymentKey: INPUT.paymentKey,
        totalAmount: INPUT.amount,
        balanceAmount: 0,
        cancels: [
          {
            cancelAmount: INPUT.amount,
            cancelStatus: "DONE",
            transactionKey,
          },
        ],
      }),
    );
    const gateway = new TossPaymentGateway(SECRET_KEY, fetchImpl);

    await expect(
      gateway.retrieveCancelOutcome({
        paymentKey: INPUT.paymentKey,
        transactionKey,
        cancelAmount: INPUT.amount,
      }),
    ).resolves.toEqual({
      status: "CANCELED",
      paymentKey: INPUT.paymentKey,
      transactionKey,
      cancelAmount: INPUT.amount,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      `https://api.tosspayments.com/v1/payments/${INPUT.paymentKey}`,
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("maps retrieveCancelOutcome non-DONE cancelStatus to UNKNOWN", async () => {
    const gateway = gatewayWith(
      jsonResponse(200, {
        status: "CANCELED",
        paymentKey: INPUT.paymentKey,
        cancels: [
          {
            cancelAmount: INPUT.amount,
            cancelStatus: "IN_PROGRESS",
            transactionKey: "txn-target",
          },
        ],
      }),
    );

    await expect(
      gateway.retrieveCancelOutcome({
        paymentKey: INPUT.paymentKey,
        transactionKey: "txn-target",
        cancelAmount: INPUT.amount,
      }),
    ).resolves.toEqual({ status: "UNKNOWN" });
  });

  it("maps retrieveCancelOutcome amount mismatch to UNKNOWN", async () => {
    const gateway = gatewayWith(
      jsonResponse(200, {
        status: "CANCELED",
        paymentKey: INPUT.paymentKey,
        cancels: [
          {
            cancelAmount: INPUT.amount + 1,
            cancelStatus: "DONE",
            transactionKey: "txn-target",
          },
        ],
      }),
    );

    await expect(
      gateway.retrieveCancelOutcome({
        paymentKey: INPUT.paymentKey,
        transactionKey: "txn-target",
        cancelAmount: INPUT.amount,
      }),
    ).resolves.toEqual({ status: "UNKNOWN" });
  });

  it("maps retrieveCancelOutcome to NOT_CANCELED only for fully uncanceled DONE payments", async () => {
    const gateway = gatewayWith(
      jsonResponse(200, {
        status: "DONE",
        paymentKey: INPUT.paymentKey,
        totalAmount: INPUT.amount,
        balanceAmount: INPUT.amount,
        cancels: null,
      }),
    );

    await expect(
      gateway.retrieveCancelOutcome({
        paymentKey: INPUT.paymentKey,
        transactionKey: "txn-missing",
        cancelAmount: INPUT.amount,
      }),
    ).resolves.toEqual({ status: "NOT_CANCELED" });
  });

  it("maps retrieveCancelOutcome empty cancels array to NOT_CANCELED when fully unpaid canceled", async () => {
    const gateway = gatewayWith(
      jsonResponse(200, {
        status: "DONE",
        paymentKey: INPUT.paymentKey,
        totalAmount: INPUT.amount,
        balanceAmount: INPUT.amount,
        cancels: [],
      }),
    );

    await expect(
      gateway.retrieveCancelOutcome({
        paymentKey: INPUT.paymentKey,
        transactionKey: "txn-missing",
        cancelAmount: INPUT.amount,
      }),
    ).resolves.toEqual({ status: "NOT_CANCELED" });
  });

  it("maps retrieveCancelOutcome PARTIAL_CANCELED to UNKNOWN", async () => {
    const gateway = gatewayWith(
      jsonResponse(200, {
        status: "PARTIAL_CANCELED",
        paymentKey: INPUT.paymentKey,
        totalAmount: INPUT.amount,
        balanceAmount: 5_000,
        cancels: [
          {
            cancelAmount: 5_000,
            cancelStatus: "DONE",
            transactionKey: "txn-partial",
          },
        ],
      }),
    );

    await expect(
      gateway.retrieveCancelOutcome({
        paymentKey: INPUT.paymentKey,
        transactionKey: "txn-partial",
        cancelAmount: 5_000,
      }),
    ).resolves.toEqual({ status: "UNKNOWN" });
  });

  it("does not treat other cancels as NOT_CANCELED without the requested transactionKey", async () => {
    const gateway = gatewayWith(
      jsonResponse(200, {
        status: "CANCELED",
        paymentKey: INPUT.paymentKey,
        totalAmount: INPUT.amount,
        balanceAmount: 0,
        cancels: [
          {
            cancelAmount: INPUT.amount,
            cancelStatus: "DONE",
            transactionKey: "txn-other",
          },
        ],
      }),
    );

    await expect(
      gateway.retrieveCancelOutcome({
        paymentKey: INPUT.paymentKey,
        transactionKey: "txn-missing",
        cancelAmount: INPUT.amount,
      }),
    ).resolves.toEqual({ status: "UNKNOWN" });
  });

  it("selects only the matching transactionKey among multiple cancels on CANCELED payments", async () => {
    const gateway = gatewayWith(
      jsonResponse(200, {
        status: "CANCELED",
        paymentKey: INPUT.paymentKey,
        totalAmount: 15_000,
        balanceAmount: 0,
        cancels: [
          {
            cancelAmount: 10_000,
            cancelStatus: "DONE",
            transactionKey: "txn-first",
          },
          {
            cancelAmount: 5_000,
            cancelStatus: "DONE",
            transactionKey: "txn-second",
          },
        ],
      }),
    );

    await expect(
      gateway.retrieveCancelOutcome({
        paymentKey: INPUT.paymentKey,
        transactionKey: "txn-second",
        cancelAmount: 5_000,
      }),
    ).resolves.toEqual({
      status: "CANCELED",
      paymentKey: INPUT.paymentKey,
      transactionKey: "txn-second",
      cancelAmount: 5_000,
    });
  });

  it("maps retrieveCancelOutcome HTTP failures to UNKNOWN", async () => {
    const gateway = gatewayWith(jsonResponse(404, { code: "NOT_FOUND_PAYMENT" }));

    await expect(
      gateway.retrieveCancelOutcome({
        paymentKey: INPUT.paymentKey,
        transactionKey: "txn-target",
        cancelAmount: INPUT.amount,
      }),
    ).resolves.toEqual({ status: "UNKNOWN" });
  });

  it("maps retrieveCancelOutcome network error to UNKNOWN", async () => {
    const fetchImpl = jest.fn<typeof fetch>().mockRejectedValue(new TypeError("network error"));
    const gateway = new TossPaymentGateway(SECRET_KEY, fetchImpl);

    await expect(
      gateway.retrieveCancelOutcome({
        paymentKey: INPUT.paymentKey,
        transactionKey: "txn-target",
        cancelAmount: INPUT.amount,
      }),
    ).resolves.toEqual({ status: "UNKNOWN" });
  });

  it("does not retrieveCancelOutcome when the secret key is blank", async () => {
    const fetchImpl = jest.fn<typeof fetch>();
    const gateway = new TossPaymentGateway("   ", fetchImpl);

    await expect(
      gateway.retrieveCancelOutcome({
        paymentKey: INPUT.paymentKey,
        transactionKey: "txn-target",
        cancelAmount: INPUT.amount,
      }),
    ).resolves.toEqual({ status: "UNKNOWN" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maps incomplete retrieveCancelOutcome responses to UNKNOWN", async () => {
    const gateway = gatewayWith(jsonResponse(200, { status: "DONE" }));

    await expect(
      gateway.retrieveCancelOutcome({
        paymentKey: INPUT.paymentKey,
        transactionKey: "txn-target",
        cancelAmount: INPUT.amount,
      }),
    ).resolves.toEqual({ status: "UNKNOWN" });
  });
});
