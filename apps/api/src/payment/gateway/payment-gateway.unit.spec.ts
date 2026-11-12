/**
 * Test Intent:
 * PaymentGateway Cancel / retrieveCancelOutcome 계약의 Input·Result 분리와
 * Unconfigured stub 동작을 보장한다. 기존 retrieve(PAID|NOT_PAID|UNKNOWN)는 유지한다.
 */

import {
  UnconfiguredPaymentGateway,
  type PaymentGatewayCancelInput,
  type PaymentGatewayCancelResult,
  type PaymentGatewayRetrieveCancelOutcomeInput,
  type PaymentGatewayRetrieveCancelOutcomeResult,
  type PaymentGatewayRetrieveResult,
} from "./payment-gateway.js";

describe("PaymentGateway contract", () => {
  const gateway = new UnconfiguredPaymentGateway();

  const cancelInput: PaymentGatewayCancelInput = {
    paymentKey: "pay-key",
    cancelReason: "예매 취소",
    cancelAmount: 10_000,
    idempotencyKey: "idem-key",
  };

  const retrieveCancelInput: PaymentGatewayRetrieveCancelOutcomeInput = {
    paymentKey: "pay-key",
    transactionKey: "txn-key",
    cancelAmount: 10_000,
  };

  it("requires idempotencyKey on cancel input and transactionKey on SUCCESS", () => {
    const success: Extract<PaymentGatewayCancelResult, { status: "SUCCESS" }> = {
      status: "SUCCESS",
      paymentKey: cancelInput.paymentKey,
      cancelAmount: cancelInput.cancelAmount,
      transactionKey: "txn-key",
    };

    expect(cancelInput.idempotencyKey).toBe("idem-key");
    expect(success.transactionKey).toBe("txn-key");
  });

  it("requires transactionKey on retrieveCancelOutcome input and separates CANCELED results", () => {
    const canceled: Extract<
      PaymentGatewayRetrieveCancelOutcomeResult,
      { status: "CANCELED" }
    > = {
      status: "CANCELED",
      paymentKey: retrieveCancelInput.paymentKey,
      transactionKey: retrieveCancelInput.transactionKey,
      cancelAmount: retrieveCancelInput.cancelAmount,
    };
    const notCanceled: PaymentGatewayRetrieveCancelOutcomeResult = {
      status: "NOT_CANCELED",
    };
    const unknown: PaymentGatewayRetrieveCancelOutcomeResult = {
      status: "UNKNOWN",
    };

    expect(retrieveCancelInput.transactionKey).toBe("txn-key");
    expect(canceled.status).toBe("CANCELED");
    expect(notCanceled.status).toBe("NOT_CANCELED");
    expect(unknown.status).toBe("UNKNOWN");
  });

  it("keeps retrieve results as PAID | NOT_PAID | UNKNOWN", async () => {
    const result: PaymentGatewayRetrieveResult = await gateway.retrieve({
      paymentKey: "pay-key",
    });

    expect(result).toEqual({ status: "UNKNOWN" });
    expect(result.status === "PAID" || result.status === "NOT_PAID" || result.status === "UNKNOWN").toBe(
      true,
    );
  });

  it("stubs cancel and retrieveCancelOutcome as UNKNOWN when unconfigured", async () => {
    await expect(gateway.cancel(cancelInput)).resolves.toEqual({ status: "UNKNOWN" });
    await expect(gateway.retrieveCancelOutcome(retrieveCancelInput)).resolves.toEqual({
      status: "UNKNOWN",
    });
  });
});
