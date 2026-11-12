/**
 * Test Intent:
 * Worker는 claim 후 transactionKey 유무에 따라 Cancel 또는 Retrieve만 수행한다.
 * cancelRequestedAt 기준 168시간 이상이면 Cancel/UNKNOWN 자동 처리를 멈추고 REVIEW로 전환한다.
 * Retrieve가 CANCELED/NOT_CANCELED로 확정되면 7일보다 PG 결과를 우선한다.
 * 최초 cancelRequestedAt은 재시도 중 변경하지 않으며, transactionKey가 있으면 Cancel을 재호출하지 않는다.
 */

import { jest } from "@jest/globals";
import { Prisma } from "@movie-booking/database-prisma";
import { InternalServerErrorException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PrismaService } from "../../database/prisma.service.js";
import { PaymentGateway } from "../../payment/gateway/payment-gateway.js";
import {
  CLAIM_REFUND_RESULT,
  PROCESS_REFUND_RESULT,
  REFUND_CANCEL_IDEMPOTENCY_TTL_MS,
  REFUND_CANCEL_REASON,
  REFUND_LEASE_TTL_MS,
  RELEASE_REFUND_LEASE_RESULT,
  WORKER_MARK_CANCEL_REQUESTED_AT_RESULT,
  WORKER_RECORD_TRANSACTION_KEY_RESULT,
  WORKER_SETTLE_REFUND_RESULT,
} from "../refund.constants.js";
import { RefundRepository } from "../repository/refund.repository.js";
import {
  isCancelIdempotencyExpired,
  ProcessRefundService,
} from "./process-refund.service.js";

const REFUND_ID = "550e8400-e29b-41d4-a716-446655440040";
const PAYMENT_ID = "550e8400-e29b-41d4-a716-446655440030";
const PAYMENT_KEY = "pay-key";
const IDEMPOTENCY_KEY = "idem-key";
const TRANSACTION_KEY = "txn-key";
const AMOUNT = 20_000;
const REQUESTED_AT = new Date("2026-10-20T00:00:00.000Z");
const BEFORE_EXPIRY = new Date(REQUESTED_AT.getTime() + REFUND_CANCEL_IDEMPOTENCY_TTL_MS - 1);
const EXACT_EXPIRY = new Date(REQUESTED_AT.getTime() + REFUND_CANCEL_IDEMPOTENCY_TTL_MS);
const AFTER_EXPIRY = new Date(REQUESTED_AT.getTime() + REFUND_CANCEL_IDEMPOTENCY_TTL_MS + 1);
const TX = { name: "transaction-client" } as unknown as Prisma.TransactionClient;

type RunTransaction = (
  callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
) => Promise<unknown>;

describe("isCancelIdempotencyExpired", () => {
  it("treats elapsed >= 7 days as expired", () => {
    expect(isCancelIdempotencyExpired(REQUESTED_AT, BEFORE_EXPIRY)).toBe(false);
    expect(isCancelIdempotencyExpired(REQUESTED_AT, EXACT_EXPIRY)).toBe(true);
    expect(isCancelIdempotencyExpired(REQUESTED_AT, AFTER_EXPIRY)).toBe(true);
  });
});

describe("ProcessRefundService", () => {
  let service: ProcessRefundService;
  let claimDue: jest.MockedFunction<RefundRepository["claimDue"]>;
  let workerMarkCancelRequestedAt: jest.MockedFunction<
    RefundRepository["workerMarkCancelRequestedAt"]
  >;
  let workerRecordTransactionKey: jest.MockedFunction<
    RefundRepository["workerRecordTransactionKey"]
  >;
  let workerCompletePendingRefund: jest.MockedFunction<
    RefundRepository["workerCompletePendingRefund"]
  >;
  let workerFailPendingRefund: jest.MockedFunction<RefundRepository["workerFailPendingRefund"]>;
  let workerReviewExpiredPendingRefund: jest.MockedFunction<
    RefundRepository["workerReviewExpiredPendingRefund"]
  >;
  let workerReviewNotCanceledPendingRefund: jest.MockedFunction<
    RefundRepository["workerReviewNotCanceledPendingRefund"]
  >;
  let releaseLease: jest.MockedFunction<RefundRepository["releaseLease"]>;
  let cancel: jest.MockedFunction<PaymentGateway["cancel"]>;
  let retrieveCancelOutcome: jest.MockedFunction<PaymentGateway["retrieveCancelOutcome"]>;
  let transaction: jest.MockedFunction<RunTransaction>;
  let dateNowSpy: jest.SpiedFunction<typeof Date.now>;

  function claimedRefund(overrides?: {
    transactionKey?: string | null;
    cancelRequestedAt?: Date | null;
  }) {
    return {
      id: REFUND_ID,
      paymentId: PAYMENT_ID,
      amount: AMOUNT,
      paymentKey: PAYMENT_KEY,
      cancelReason: REFUND_CANCEL_REASON,
      idempotencyKey: IDEMPOTENCY_KEY,
      cancelRequestedAt: overrides?.cancelRequestedAt ?? null,
      transactionKey: overrides?.transactionKey ?? null,
      leaseToken: "lease",
      leaseUntil: new Date(EXACT_EXPIRY.getTime() + REFUND_LEASE_TTL_MS),
    };
  }

  function freezeNow(now: Date) {
    dateNowSpy = jest.spyOn(Date, "now").mockReturnValue(now.getTime());
  }

  beforeEach(async () => {
    claimDue = jest.fn<RefundRepository["claimDue"]>();
    workerMarkCancelRequestedAt = jest.fn<RefundRepository["workerMarkCancelRequestedAt"]>();
    workerRecordTransactionKey = jest.fn<RefundRepository["workerRecordTransactionKey"]>();
    workerCompletePendingRefund = jest.fn<RefundRepository["workerCompletePendingRefund"]>();
    workerFailPendingRefund = jest.fn<RefundRepository["workerFailPendingRefund"]>();
    workerReviewExpiredPendingRefund =
      jest.fn<RefundRepository["workerReviewExpiredPendingRefund"]>();
    workerReviewNotCanceledPendingRefund =
      jest.fn<RefundRepository["workerReviewNotCanceledPendingRefund"]>();
    releaseLease = jest.fn<RefundRepository["releaseLease"]>();
    cancel = jest.fn<PaymentGateway["cancel"]>();
    retrieveCancelOutcome = jest.fn<PaymentGateway["retrieveCancelOutcome"]>();
    transaction = jest.fn<RunTransaction>(async (callback) => callback(TX));

    claimDue.mockResolvedValue({
      result: CLAIM_REFUND_RESULT.CLAIMED,
      refund: claimedRefund(),
    });
    workerMarkCancelRequestedAt.mockResolvedValue({
      result: WORKER_MARK_CANCEL_REQUESTED_AT_RESULT.MARKED,
      cancelRequestedAt: REQUESTED_AT,
    });
    workerRecordTransactionKey.mockResolvedValue({
      result: WORKER_RECORD_TRANSACTION_KEY_RESULT.RECORDED,
    });
    releaseLease.mockResolvedValue({ result: RELEASE_REFUND_LEASE_RESULT.RELEASED });

    const moduleRef = await Test.createTestingModule({
      providers: [
        ProcessRefundService,
        {
          provide: PrismaService,
          useValue: { client: { $transaction: transaction } },
        },
        {
          provide: RefundRepository,
          useValue: {
            claimDue,
            workerMarkCancelRequestedAt,
            workerRecordTransactionKey,
            workerCompletePendingRefund,
            workerFailPendingRefund,
            workerReviewExpiredPendingRefund,
            workerReviewNotCanceledPendingRefund,
            releaseLease,
          },
        },
        {
          provide: PaymentGateway,
          useValue: { cancel, retrieveCancelOutcome },
        },
      ],
    }).compile();

    service = moduleRef.get(ProcessRefundService);
  });

  afterEach(() => {
    dateNowSpy?.mockRestore();
  });

  it("calls Cancel when transactionKey is missing and idempotency has not expired", async () => {
    freezeNow(BEFORE_EXPIRY);
    cancel.mockResolvedValue({ status: "UNKNOWN" });

    await expect(service.execute(REFUND_ID)).resolves.toEqual({
      result: PROCESS_REFUND_RESULT.PENDING,
    });

    expect(cancel).toHaveBeenCalledWith({
      paymentKey: PAYMENT_KEY,
      cancelReason: REFUND_CANCEL_REASON,
      cancelAmount: AMOUNT,
      idempotencyKey: IDEMPOTENCY_KEY,
    });
    expect(retrieveCancelOutcome).not.toHaveBeenCalled();
    expect(workerReviewExpiredPendingRefund).not.toHaveBeenCalled();
    expect(releaseLease).toHaveBeenCalled();
  });

  it("reviews without Cancel when transactionKey is missing at exactly 7 days", async () => {
    freezeNow(EXACT_EXPIRY);
    workerReviewExpiredPendingRefund.mockResolvedValue({
      result: WORKER_SETTLE_REFUND_RESULT.REVIEWED,
      refund: {
        id: REFUND_ID,
        paymentId: PAYMENT_ID,
        status: "REVIEW",
        amount: AMOUNT,
        completedAt: null,
        failedAt: null,
        transactionKey: null,
      },
    });

    await expect(service.execute(REFUND_ID)).resolves.toEqual({
      result: PROCESS_REFUND_RESULT.REVIEWED,
    });

    expect(cancel).not.toHaveBeenCalled();
    expect(workerReviewExpiredPendingRefund).toHaveBeenCalledWith(
      TX,
      REFUND_ID,
      expect.any(String),
      EXACT_EXPIRY,
      REQUESTED_AT,
    );
  });

  it("keeps PENDING and releases lease on Retrieve UNKNOWN before expiry", async () => {
    freezeNow(BEFORE_EXPIRY);
    claimDue.mockResolvedValue({
      result: CLAIM_REFUND_RESULT.CLAIMED,
      refund: claimedRefund({
        transactionKey: TRANSACTION_KEY,
        cancelRequestedAt: REQUESTED_AT,
      }),
    });
    retrieveCancelOutcome.mockResolvedValue({ status: "UNKNOWN" });

    await expect(service.execute(REFUND_ID)).resolves.toEqual({
      result: PROCESS_REFUND_RESULT.PENDING,
    });

    expect(cancel).not.toHaveBeenCalled();
    expect(retrieveCancelOutcome).toHaveBeenCalledWith({
      paymentKey: PAYMENT_KEY,
      transactionKey: TRANSACTION_KEY,
      cancelAmount: AMOUNT,
    });
    expect(workerReviewExpiredPendingRefund).not.toHaveBeenCalled();
    expect(releaseLease).toHaveBeenCalledWith(TX, REFUND_ID, expect.any(String));
  });

  it("reviews on Retrieve UNKNOWN at exactly 7 days", async () => {
    freezeNow(EXACT_EXPIRY);
    claimDue.mockResolvedValue({
      result: CLAIM_REFUND_RESULT.CLAIMED,
      refund: claimedRefund({
        transactionKey: TRANSACTION_KEY,
        cancelRequestedAt: REQUESTED_AT,
      }),
    });
    retrieveCancelOutcome.mockResolvedValue({ status: "UNKNOWN" });
    workerReviewExpiredPendingRefund.mockResolvedValue({
      result: WORKER_SETTLE_REFUND_RESULT.REVIEWED,
      refund: {
        id: REFUND_ID,
        paymentId: PAYMENT_ID,
        status: "REVIEW",
        amount: AMOUNT,
        completedAt: null,
        failedAt: null,
        transactionKey: TRANSACTION_KEY,
      },
    });

    await expect(service.execute(REFUND_ID)).resolves.toEqual({
      result: PROCESS_REFUND_RESULT.REVIEWED,
    });

    expect(cancel).not.toHaveBeenCalled();
    expect(workerReviewExpiredPendingRefund).toHaveBeenCalledWith(
      TX,
      REFUND_ID,
      expect.any(String),
      EXACT_EXPIRY,
      REQUESTED_AT,
    );
  });

  it("reviews on Retrieve UNKNOWN after 7 days", async () => {
    freezeNow(AFTER_EXPIRY);
    claimDue.mockResolvedValue({
      result: CLAIM_REFUND_RESULT.CLAIMED,
      refund: claimedRefund({
        transactionKey: TRANSACTION_KEY,
        cancelRequestedAt: REQUESTED_AT,
      }),
    });
    retrieveCancelOutcome.mockResolvedValue({ status: "UNKNOWN" });
    workerReviewExpiredPendingRefund.mockResolvedValue({
      result: WORKER_SETTLE_REFUND_RESULT.REVIEWED,
      refund: {
        id: REFUND_ID,
        paymentId: PAYMENT_ID,
        status: "REVIEW",
        amount: AMOUNT,
        completedAt: null,
        failedAt: null,
        transactionKey: TRANSACTION_KEY,
      },
    });

    await expect(service.execute(REFUND_ID)).resolves.toEqual({
      result: PROCESS_REFUND_RESULT.REVIEWED,
    });
  });

  it("completes on Retrieve CANCELED even after 7 days", async () => {
    freezeNow(AFTER_EXPIRY);
    claimDue.mockResolvedValue({
      result: CLAIM_REFUND_RESULT.CLAIMED,
      refund: claimedRefund({
        transactionKey: TRANSACTION_KEY,
        cancelRequestedAt: REQUESTED_AT,
      }),
    });
    retrieveCancelOutcome.mockResolvedValue({
      status: "CANCELED",
      paymentKey: PAYMENT_KEY,
      transactionKey: TRANSACTION_KEY,
      cancelAmount: AMOUNT,
    });
    workerCompletePendingRefund.mockResolvedValue({
      result: WORKER_SETTLE_REFUND_RESULT.COMPLETED,
      refund: {
        id: REFUND_ID,
        paymentId: PAYMENT_ID,
        status: "COMPLETED",
        amount: AMOUNT,
        completedAt: AFTER_EXPIRY,
        failedAt: null,
        transactionKey: TRANSACTION_KEY,
      },
    });

    await expect(service.execute(REFUND_ID)).resolves.toEqual({
      result: PROCESS_REFUND_RESULT.COMPLETED,
    });

    expect(cancel).not.toHaveBeenCalled();
    expect(workerReviewExpiredPendingRefund).not.toHaveBeenCalled();
    expect(workerCompletePendingRefund).toHaveBeenCalled();
  });

  it("reviews on Retrieve NOT_CANCELED before expiry", async () => {
    freezeNow(BEFORE_EXPIRY);
    claimDue.mockResolvedValue({
      result: CLAIM_REFUND_RESULT.CLAIMED,
      refund: claimedRefund({
        transactionKey: TRANSACTION_KEY,
        cancelRequestedAt: REQUESTED_AT,
      }),
    });
    retrieveCancelOutcome.mockResolvedValue({ status: "NOT_CANCELED" });
    workerReviewNotCanceledPendingRefund.mockResolvedValue({
      result: WORKER_SETTLE_REFUND_RESULT.REVIEWED,
      refund: {
        id: REFUND_ID,
        paymentId: PAYMENT_ID,
        status: "REVIEW",
        amount: AMOUNT,
        completedAt: null,
        failedAt: null,
        transactionKey: TRANSACTION_KEY,
      },
    });

    await expect(service.execute(REFUND_ID)).resolves.toEqual({
      result: PROCESS_REFUND_RESULT.REVIEWED,
    });

    expect(cancel).not.toHaveBeenCalled();
    expect(workerReviewNotCanceledPendingRefund).toHaveBeenCalled();
    expect(workerReviewExpiredPendingRefund).not.toHaveBeenCalled();
  });

  it("does not call Cancel when transactionKey already exists", async () => {
    freezeNow(BEFORE_EXPIRY);
    claimDue.mockResolvedValue({
      result: CLAIM_REFUND_RESULT.CLAIMED,
      refund: claimedRefund({
        transactionKey: TRANSACTION_KEY,
        cancelRequestedAt: REQUESTED_AT,
      }),
    });
    retrieveCancelOutcome.mockResolvedValue({ status: "UNKNOWN" });

    await service.execute(REFUND_ID);

    expect(cancel).not.toHaveBeenCalled();
    expect(workerMarkCancelRequestedAt).not.toHaveBeenCalled();
  });

  it("reuses the persisted cancelRequestedAt without rewriting it on retry", async () => {
    freezeNow(BEFORE_EXPIRY);
    claimDue.mockResolvedValue({
      result: CLAIM_REFUND_RESULT.CLAIMED,
      refund: claimedRefund({ cancelRequestedAt: null }),
    });
    workerMarkCancelRequestedAt.mockResolvedValue({
      result: WORKER_MARK_CANCEL_REQUESTED_AT_RESULT.ALREADY_SET,
      cancelRequestedAt: REQUESTED_AT,
    });
    cancel.mockResolvedValue({ status: "UNKNOWN" });

    await service.execute(REFUND_ID);

    expect(workerMarkCancelRequestedAt).toHaveBeenCalledWith(
      TX,
      REFUND_ID,
      expect.any(String),
      BEFORE_EXPIRY,
      BEFORE_EXPIRY,
    );
    expect(cancel).toHaveBeenCalled();
    expect(workerReviewExpiredPendingRefund).not.toHaveBeenCalled();
  });

  it("passes the held lease token into expired REVIEW", async () => {
    freezeNow(EXACT_EXPIRY);
    workerReviewExpiredPendingRefund.mockResolvedValue({
      result: WORKER_SETTLE_REFUND_RESULT.REVIEWED,
      refund: {
        id: REFUND_ID,
        paymentId: PAYMENT_ID,
        status: "REVIEW",
        amount: AMOUNT,
        completedAt: null,
        failedAt: null,
        transactionKey: null,
      },
    });

    await service.execute(REFUND_ID);

    const leaseToken = workerReviewExpiredPendingRefund.mock.calls[0]?.[2];
    expect(typeof leaseToken).toBe("string");
    expect(claimDue.mock.calls[0]?.[3]).toBe(leaseToken);
  });

  it("does not review as expired when the worker no longer holds the lease", async () => {
    freezeNow(EXACT_EXPIRY);
    workerReviewExpiredPendingRefund.mockResolvedValue({
      result: WORKER_SETTLE_REFUND_RESULT.NOT_HELD,
    });

    await expect(service.execute(REFUND_ID)).rejects.toBeInstanceOf(InternalServerErrorException);
    expect(cancel).not.toHaveBeenCalled();
  });
});
