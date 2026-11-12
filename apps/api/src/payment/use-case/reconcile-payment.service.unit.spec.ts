/**
 * Test Intent:
 * Claim에 성공하고 PG 조회가 NOT_PAID이면 같은 트랜잭션에서 Payment를 FAILED로, Reconciliation을 COMPLETED·NOT_PAID로 바꾼다.
 * PG 조회가 UNKNOWN이면 Lease를 유지한 채 nextProcessAt만 재예약한다.
 * PG 조회가 PAID이고 identity·amount가 일치하면 같은 트랜잭션에서 Payment PAID, Refund PENDING, Reconciliation COMPLETED·REFUND_CREATED를 기록하고 Commit 이후 ProcessRefundService를 호출한다.
 * orderId·amount 불일치면 Payment·Refund를 바꾸지 않고 Reconciliation만 REVIEW·IDENTITY_MISMATCH로 전환한다.
 * 기존 Refund가 있거나 Lease fencing이 실패하면 전체 Transaction이 확정되지 않는다.
 * Claim에 실패하면 PG 조회와 상태 변경을 하지 않는다.
 */

import { jest } from "@jest/globals";
import { Prisma } from "@movie-booking/database-prisma";
import { InternalServerErrorException, Logger } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PrismaService } from "../../database/prisma.service.js";
import { RefundRepository } from "../../refund/repository/refund.repository.js";
import { ProcessRefundService } from "../../refund/use-case/process-refund.service.js";
import { PaymentGateway } from "../gateway/payment-gateway.js";
import {
  CLAIM_RECONCILIATION_RESULT,
  COMPLETE_RECONCILIATION_AS_NOT_PAID_RESULT,
  COMPLETE_RECONCILIATION_AS_REFUND_CREATED_RESULT,
  FAIL_RECONCILIATION_PAYMENT_RESULT,
  MARK_RECONCILIATION_REVIEW_FOR_IDENTITY_MISMATCH_RESULT,
  PAY_RECONCILIATION_PAYMENT_RESULT,
  RECONCILE_PAYMENT_RESULT,
  RECONCILIATION_LEASE_TTL_MS,
  RESCHEDULE_RECONCILIATION_AFTER_UNKNOWN_RESULT,
} from "../payment.constants.js";
import { PaymentRepository } from "../repository/payment.repository.js";
import { ReconcilePaymentRepository } from "../repository/reconcile-payment.repository.js";
import { ReconcilePaymentService } from "./reconcile-payment.service.js";

const PAYMENT_ID = "550e8400-e29b-41d4-a716-446655440030";
const BOOKING_ID = "550e8400-e29b-41d4-a716-446655440020";
const RECONCILIATION_ID = "550e8400-e29b-41d4-a716-446655440040";
const REFUND_ID = "550e8400-e29b-41d4-a716-446655440060";
const LEASE_TOKEN = "550e8400-e29b-41d4-a716-446655440050";
const ORDER_ID = "ord_550e8400-e29b-41d4-a716-446655440030";
const PAYMENT_KEY = "pay-key";
const AMOUNT = 10_000;
const TX = { name: "transaction-client" } as unknown as Prisma.TransactionClient;
const NOW = new Date("2026-10-31T12:00:00.000Z");
const LEASE_UNTIL = new Date(NOW.getTime() + RECONCILIATION_LEASE_TTL_MS);

type RunTransaction = (
  callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
) => Promise<unknown>;

describe("ReconcilePaymentService", () => {
  let service: ReconcilePaymentService;
  let paymentRepository: {
    findReconciliationPayment: jest.MockedFunction<PaymentRepository["findReconciliationPayment"]>;
    failReconciliationPayment: jest.MockedFunction<PaymentRepository["failReconciliationPayment"]>;
    payReconciliationPayment: jest.MockedFunction<PaymentRepository["payReconciliationPayment"]>;
  };
  let reconcilePaymentRepository: {
    claimDue: jest.MockedFunction<ReconcilePaymentRepository["claimDue"]>;
    completeAsNotPaid: jest.MockedFunction<ReconcilePaymentRepository["completeAsNotPaid"]>;
    completeAsRefundCreated: jest.MockedFunction<
      ReconcilePaymentRepository["completeAsRefundCreated"]
    >;
    markReviewForIdentityMismatch: jest.MockedFunction<
      ReconcilePaymentRepository["markReviewForIdentityMismatch"]
    >;
    rescheduleAfterUnknown: jest.MockedFunction<
      ReconcilePaymentRepository["rescheduleAfterUnknown"]
    >;
  };
  let refundRepository: {
    findByPaymentId: jest.MockedFunction<RefundRepository["findByPaymentId"]>;
    createPendingRefund: jest.MockedFunction<RefundRepository["createPendingRefund"]>;
  };
  let processRefundService: {
    execute: jest.MockedFunction<ProcessRefundService["execute"]>;
  };
  let paymentGateway: {
    retrieve: jest.MockedFunction<PaymentGateway["retrieve"]>;
  };
  let transaction: jest.MockedFunction<RunTransaction>;

  beforeEach(async () => {
    paymentRepository = {
      findReconciliationPayment: jest.fn<PaymentRepository["findReconciliationPayment"]>(),
      failReconciliationPayment: jest.fn<PaymentRepository["failReconciliationPayment"]>(),
      payReconciliationPayment: jest.fn<PaymentRepository["payReconciliationPayment"]>(),
    };
    reconcilePaymentRepository = {
      claimDue: jest.fn<ReconcilePaymentRepository["claimDue"]>(),
      completeAsNotPaid: jest.fn<ReconcilePaymentRepository["completeAsNotPaid"]>(),
      completeAsRefundCreated: jest.fn<ReconcilePaymentRepository["completeAsRefundCreated"]>(),
      markReviewForIdentityMismatch: jest.fn<
        ReconcilePaymentRepository["markReviewForIdentityMismatch"]
      >(),
      rescheduleAfterUnknown: jest.fn<ReconcilePaymentRepository["rescheduleAfterUnknown"]>(),
    };
    refundRepository = {
      findByPaymentId: jest.fn<RefundRepository["findByPaymentId"]>(),
      createPendingRefund: jest.fn<RefundRepository["createPendingRefund"]>(),
    };
    processRefundService = {
      execute: jest.fn<ProcessRefundService["execute"]>().mockResolvedValue({
        result: "PENDING",
      }),
    };
    paymentGateway = {
      retrieve: jest.fn<PaymentGateway["retrieve"]>(),
    };
    transaction = jest.fn<RunTransaction>(async (callback) => callback(TX));
    jest.spyOn(Date, "now").mockReturnValue(NOW.getTime());

    const moduleRef = await Test.createTestingModule({
      providers: [
        ReconcilePaymentService,
        {
          provide: PrismaService,
          useValue: { client: { $transaction: transaction } },
        },
        { provide: PaymentRepository, useValue: paymentRepository },
        { provide: ReconcilePaymentRepository, useValue: reconcilePaymentRepository },
        { provide: RefundRepository, useValue: refundRepository },
        { provide: ProcessRefundService, useValue: processRefundService },
        { provide: PaymentGateway, useValue: paymentGateway },
      ],
    }).compile();

    service = moduleRef.get(ReconcilePaymentService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function mockClaimed() {
    reconcilePaymentRepository.claimDue.mockResolvedValue({
      result: CLAIM_RECONCILIATION_RESULT.CLAIMED,
      reconciliation: {
        id: RECONCILIATION_ID,
        paymentId: PAYMENT_ID,
        leaseToken: LEASE_TOKEN,
        leaseUntil: LEASE_UNTIL,
      },
    });
    paymentRepository.findReconciliationPayment.mockResolvedValue({
      orderId: ORDER_ID,
      amount: AMOUNT,
      paymentKey: PAYMENT_KEY,
    });
  }

  function mockPaidGateway(overrides?: { orderId?: string; amount?: number; paymentKey?: string }) {
    paymentGateway.retrieve.mockResolvedValue({
      status: "PAID",
      paymentKey: overrides?.paymentKey ?? PAYMENT_KEY,
      orderId: overrides?.orderId ?? ORDER_ID,
      amount: overrides?.amount ?? AMOUNT,
      approvedAt: NOW,
    });
  }

  it("applies FAILED payment and NOT_PAID reconciliation completion in one transaction", async () => {
    mockClaimed();
    paymentGateway.retrieve.mockResolvedValue({ status: "NOT_PAID" });
    paymentRepository.failReconciliationPayment.mockResolvedValue({
      result: FAIL_RECONCILIATION_PAYMENT_RESULT.FAILED,
      payment: {
        id: PAYMENT_ID,
        bookingId: BOOKING_ID,
        status: "FAILED",
        failedAt: NOW,
      },
    });
    reconcilePaymentRepository.completeAsNotPaid.mockResolvedValue({
      result: COMPLETE_RECONCILIATION_AS_NOT_PAID_RESULT.COMPLETED,
    });

    await expect(service.execute(RECONCILIATION_ID)).resolves.toEqual({
      result: RECONCILE_PAYMENT_RESULT.NOT_PAID,
    });

    expect(transaction).toHaveBeenCalledTimes(2);
    expect(reconcilePaymentRepository.claimDue).toHaveBeenCalledWith(TX, RECONCILIATION_ID, NOW);
    expect(paymentRepository.findReconciliationPayment).toHaveBeenCalledWith(PAYMENT_ID);
    expect(paymentGateway.retrieve).toHaveBeenCalledWith({ paymentKey: PAYMENT_KEY });
    expect(paymentRepository.failReconciliationPayment).toHaveBeenCalledWith(
      TX,
      PAYMENT_ID,
      NOW,
    );
    expect(reconcilePaymentRepository.completeAsNotPaid).toHaveBeenCalledWith(
      TX,
      RECONCILIATION_ID,
      LEASE_TOKEN,
      NOW,
    );
    expect(reconcilePaymentRepository.rescheduleAfterUnknown).not.toHaveBeenCalled();
    expect(paymentRepository.failReconciliationPayment.mock.invocationCallOrder[0]).toBeLessThan(
      reconcilePaymentRepository.completeAsNotPaid.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("reschedules UNKNOWN retrieve results with the claimed lease token", async () => {
    mockClaimed();
    paymentGateway.retrieve.mockResolvedValue({ status: "UNKNOWN" });
    reconcilePaymentRepository.rescheduleAfterUnknown.mockResolvedValue({
      result: RESCHEDULE_RECONCILIATION_AFTER_UNKNOWN_RESULT.RESCHEDULED,
    });

    await expect(service.execute(RECONCILIATION_ID)).resolves.toEqual({
      result: RECONCILE_PAYMENT_RESULT.UNKNOWN,
    });

    expect(transaction).toHaveBeenCalledTimes(2);
    expect(paymentGateway.retrieve).toHaveBeenCalledWith({ paymentKey: PAYMENT_KEY });
    expect(reconcilePaymentRepository.rescheduleAfterUnknown).toHaveBeenCalledWith(
      TX,
      RECONCILIATION_ID,
      LEASE_TOKEN,
      NOW,
    );
    expect(paymentRepository.failReconciliationPayment).not.toHaveBeenCalled();
    expect(reconcilePaymentRepository.completeAsNotPaid).not.toHaveBeenCalled();
    expect(paymentGateway.retrieve.mock.invocationCallOrder[0]).toBeLessThan(
      reconcilePaymentRepository.rescheduleAfterUnknown.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("propagates when UNKNOWN reschedule does not succeed", async () => {
    mockClaimed();
    paymentGateway.retrieve.mockResolvedValue({ status: "UNKNOWN" });
    reconcilePaymentRepository.rescheduleAfterUnknown.mockResolvedValue({
      result: RESCHEDULE_RECONCILIATION_AFTER_UNKNOWN_RESULT.NOT_HELD,
    });

    await expect(service.execute(RECONCILIATION_ID)).rejects.toThrow(InternalServerErrorException);

    expect(transaction).toHaveBeenCalledTimes(2);
    expect(reconcilePaymentRepository.rescheduleAfterUnknown).toHaveBeenCalled();
  });

  it("pays payment, creates pending refund, and completes reconciliation as REFUND_CREATED in one transaction", async () => {
    mockClaimed();
    mockPaidGateway();
    refundRepository.findByPaymentId.mockResolvedValue(null);
    paymentRepository.payReconciliationPayment.mockResolvedValue({
      result: PAY_RECONCILIATION_PAYMENT_RESULT.PAID,
      payment: {
        id: PAYMENT_ID,
        bookingId: BOOKING_ID,
        status: "PAID",
        amount: AMOUNT,
        paidAt: NOW,
      },
    });
    refundRepository.createPendingRefund.mockResolvedValue({
      id: REFUND_ID,
      paymentId: PAYMENT_ID,
      amount: AMOUNT,
      status: "PENDING",
      idempotencyKey: "idem-1",
      paymentKey: PAYMENT_KEY,
      cancelReason: "CANCEL",
    });
    reconcilePaymentRepository.completeAsRefundCreated.mockResolvedValue({
      result: COMPLETE_RECONCILIATION_AS_REFUND_CREATED_RESULT.COMPLETED,
    });

    await expect(service.execute(RECONCILIATION_ID)).resolves.toEqual({
      result: RECONCILE_PAYMENT_RESULT.PAID,
    });

    expect(transaction).toHaveBeenCalledTimes(2);
    expect(refundRepository.findByPaymentId).toHaveBeenCalledWith(TX, PAYMENT_ID);
    expect(paymentRepository.payReconciliationPayment).toHaveBeenCalledWith(
      TX,
      PAYMENT_ID,
      NOW,
    );
    expect(refundRepository.createPendingRefund).toHaveBeenCalledWith(TX, PAYMENT_ID, AMOUNT);
    expect(reconcilePaymentRepository.completeAsRefundCreated).toHaveBeenCalledWith(
      TX,
      RECONCILIATION_ID,
      LEASE_TOKEN,
      NOW,
    );
    expect(paymentRepository.payReconciliationPayment.mock.invocationCallOrder[0]).toBeLessThan(
      refundRepository.createPendingRefund.mock.invocationCallOrder[0] ?? 0,
    );
    expect(refundRepository.createPendingRefund.mock.invocationCallOrder[0]).toBeLessThan(
      reconcilePaymentRepository.completeAsRefundCreated.mock.invocationCallOrder[0] ?? 0,
    );
    expect(processRefundService.execute).toHaveBeenCalledWith(REFUND_ID);
    expect(processRefundService.execute.mock.invocationCallOrder[0]).toBeGreaterThan(
      reconcilePaymentRepository.completeAsRefundCreated.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("marks REVIEW with IDENTITY_MISMATCH when gateway orderId does not match", async () => {
    mockClaimed();
    mockPaidGateway({ orderId: "other-order" });
    reconcilePaymentRepository.markReviewForIdentityMismatch.mockResolvedValue({
      result: MARK_RECONCILIATION_REVIEW_FOR_IDENTITY_MISMATCH_RESULT.REVIEWED,
    });

    await expect(service.execute(RECONCILIATION_ID)).resolves.toEqual({
      result: RECONCILE_PAYMENT_RESULT.IDENTITY_MISMATCH,
    });

    expect(transaction).toHaveBeenCalledTimes(2);
    expect(reconcilePaymentRepository.markReviewForIdentityMismatch).toHaveBeenCalledWith(
      TX,
      RECONCILIATION_ID,
      LEASE_TOKEN,
      NOW,
    );
    expect(paymentRepository.payReconciliationPayment).not.toHaveBeenCalled();
    expect(refundRepository.createPendingRefund).not.toHaveBeenCalled();
    expect(reconcilePaymentRepository.completeAsRefundCreated).not.toHaveBeenCalled();
    expect(processRefundService.execute).not.toHaveBeenCalled();
  });

  it("marks REVIEW with IDENTITY_MISMATCH when gateway amount does not match", async () => {
    mockClaimed();
    mockPaidGateway({ amount: AMOUNT + 1 });
    reconcilePaymentRepository.markReviewForIdentityMismatch.mockResolvedValue({
      result: MARK_RECONCILIATION_REVIEW_FOR_IDENTITY_MISMATCH_RESULT.REVIEWED,
    });

    await expect(service.execute(RECONCILIATION_ID)).resolves.toEqual({
      result: RECONCILE_PAYMENT_RESULT.IDENTITY_MISMATCH,
    });

    expect(paymentRepository.payReconciliationPayment).not.toHaveBeenCalled();
    expect(refundRepository.createPendingRefund).not.toHaveBeenCalled();
    expect(processRefundService.execute).not.toHaveBeenCalled();
  });

  it("rejects when a refund already exists for the payment", async () => {
    mockClaimed();
    mockPaidGateway();
    refundRepository.findByPaymentId.mockResolvedValue({
      id: REFUND_ID,
      paymentId: PAYMENT_ID,
      amount: AMOUNT,
      status: "PENDING",
    });

    await expect(service.execute(RECONCILIATION_ID)).rejects.toThrow(InternalServerErrorException);

    expect(paymentRepository.payReconciliationPayment).not.toHaveBeenCalled();
    expect(refundRepository.createPendingRefund).not.toHaveBeenCalled();
    expect(reconcilePaymentRepository.completeAsRefundCreated).not.toHaveBeenCalled();
    expect(processRefundService.execute).not.toHaveBeenCalled();
  });

  it("rolls back when completing reconciliation as REFUND_CREATED does not hold the lease", async () => {
    mockClaimed();
    mockPaidGateway();
    refundRepository.findByPaymentId.mockResolvedValue(null);
    paymentRepository.payReconciliationPayment.mockResolvedValue({
      result: PAY_RECONCILIATION_PAYMENT_RESULT.PAID,
      payment: {
        id: PAYMENT_ID,
        bookingId: BOOKING_ID,
        status: "PAID",
        amount: AMOUNT,
        paidAt: NOW,
      },
    });
    refundRepository.createPendingRefund.mockResolvedValue({
      id: REFUND_ID,
      paymentId: PAYMENT_ID,
      amount: AMOUNT,
      status: "PENDING",
      idempotencyKey: "idem-1",
      paymentKey: PAYMENT_KEY,
      cancelReason: "CANCEL",
    });
    reconcilePaymentRepository.completeAsRefundCreated.mockResolvedValue({
      result: COMPLETE_RECONCILIATION_AS_REFUND_CREATED_RESULT.NOT_HELD,
    });

    await expect(service.execute(RECONCILIATION_ID)).rejects.toThrow(InternalServerErrorException);

    expect(transaction).toHaveBeenCalledTimes(2);
    expect(paymentRepository.payReconciliationPayment).toHaveBeenCalled();
    expect(refundRepository.createPendingRefund).toHaveBeenCalled();
    expect(reconcilePaymentRepository.completeAsRefundCreated).toHaveBeenCalled();
    expect(processRefundService.execute).not.toHaveBeenCalled();
  });

  it("preserves committed refund when ProcessRefundService fails after commit", async () => {
    mockClaimed();
    mockPaidGateway();
    refundRepository.findByPaymentId.mockResolvedValue(null);
    paymentRepository.payReconciliationPayment.mockResolvedValue({
      result: PAY_RECONCILIATION_PAYMENT_RESULT.PAID,
      payment: {
        id: PAYMENT_ID,
        bookingId: BOOKING_ID,
        status: "PAID",
        amount: AMOUNT,
        paidAt: NOW,
      },
    });
    refundRepository.createPendingRefund.mockResolvedValue({
      id: REFUND_ID,
      paymentId: PAYMENT_ID,
      amount: AMOUNT,
      status: "PENDING",
      idempotencyKey: "idem-1",
      paymentKey: PAYMENT_KEY,
      cancelReason: "CANCEL",
    });
    reconcilePaymentRepository.completeAsRefundCreated.mockResolvedValue({
      result: COMPLETE_RECONCILIATION_AS_REFUND_CREATED_RESULT.COMPLETED,
    });
    const workerError = new Error("worker failed");
    processRefundService.execute.mockRejectedValue(workerError);
    const loggerError = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);

    await expect(service.execute(RECONCILIATION_ID)).resolves.toEqual({
      result: RECONCILE_PAYMENT_RESULT.PAID,
    });

    await Promise.resolve();
    expect(processRefundService.execute).toHaveBeenCalledWith(REFUND_ID);
    expect(loggerError).toHaveBeenCalledWith(
      `Failed to process refund ${REFUND_ID}`,
      workerError.stack,
    );
  });

  it("rolls back when failing the reconciliation payment does not succeed", async () => {
    mockClaimed();
    paymentGateway.retrieve.mockResolvedValue({ status: "NOT_PAID" });
    paymentRepository.failReconciliationPayment.mockResolvedValue({
      result: FAIL_RECONCILIATION_PAYMENT_RESULT.NOT_RECONCILIATION_REQUIRED,
    });

    await expect(service.execute(RECONCILIATION_ID)).rejects.toThrow(InternalServerErrorException);

    expect(transaction).toHaveBeenCalledTimes(2);
    expect(reconcilePaymentRepository.completeAsNotPaid).not.toHaveBeenCalled();
  });

  it("rolls back when completing reconciliation as NOT_PAID does not succeed", async () => {
    mockClaimed();
    paymentGateway.retrieve.mockResolvedValue({ status: "NOT_PAID" });
    paymentRepository.failReconciliationPayment.mockResolvedValue({
      result: FAIL_RECONCILIATION_PAYMENT_RESULT.FAILED,
      payment: {
        id: PAYMENT_ID,
        bookingId: BOOKING_ID,
        status: "FAILED",
        failedAt: NOW,
      },
    });
    reconcilePaymentRepository.completeAsNotPaid.mockResolvedValue({
      result: COMPLETE_RECONCILIATION_AS_NOT_PAID_RESULT.NOT_HELD,
    });

    await expect(service.execute(RECONCILIATION_ID)).rejects.toThrow(InternalServerErrorException);

    expect(transaction).toHaveBeenCalledTimes(2);
    expect(paymentRepository.failReconciliationPayment).toHaveBeenCalled();
    expect(reconcilePaymentRepository.completeAsNotPaid).toHaveBeenCalled();
  });

  it("skips PG retrieve and state changes when claim fails", async () => {
    reconcilePaymentRepository.claimDue.mockResolvedValue({
      result: CLAIM_RECONCILIATION_RESULT.NOT_CLAIMED,
    });

    await expect(service.execute(RECONCILIATION_ID)).resolves.toEqual({
      result: RECONCILE_PAYMENT_RESULT.NOT_CLAIMED,
    });

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(paymentRepository.findReconciliationPayment).not.toHaveBeenCalled();
    expect(paymentGateway.retrieve).not.toHaveBeenCalled();
    expect(paymentRepository.failReconciliationPayment).not.toHaveBeenCalled();
    expect(reconcilePaymentRepository.completeAsNotPaid).not.toHaveBeenCalled();
    expect(reconcilePaymentRepository.rescheduleAfterUnknown).not.toHaveBeenCalled();
    expect(paymentRepository.payReconciliationPayment).not.toHaveBeenCalled();
  });
});
