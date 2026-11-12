/**
 * Test Intent:
 * findByPaymentId는 Payment에 연결된 Refund 존재 여부를 조회한다.
 * PENDING Refund 생성 시 paymentKey·cancelReason·idempotencyKey 스냅샷이 저장되고 Payment당 하나만 만든다.
 * Worker: Lease claim/release와 leaseToken fencing으로 상태 전이를 보호한다.
 * Worker cancelRequestedAt은 null인 PENDING + held lease에만 한 번 기록된다.
 * Worker transactionKey는 held PENDING + null이고 cancelRequestedAt이 있을 때만 기록되며, 최초 기록 이후 변경되지 않는다.
 * 만료 REVIEW는 cancelRequestedAt 만료(+ lease)만 보며 transactionKey 유무와 무관하다.
 * NOT_CANCELED REVIEW는 key 있음만 허용한다.
 * FAILED·COMPLETED·REVIEW는 서로를 덮어쓰지 않는다. Payment와 Booking은 바뀌지 않는다.
 */

import { jest } from "@jest/globals";
import { Prisma } from "@movie-booking/database-prisma";
import { BOOKING_CANCELLED_STATUS } from "../../booking/booking.constants.js";
import { PrismaService } from "../../database/prisma.service.js";
import { PAYMENT_PAID_STATUS } from "../../payment/payment.constants.js";
import {
  CLAIM_REFUND_RESULT,
  REFUND_CANCEL_IDEMPOTENCY_TTL_MS,
  REFUND_CANCEL_REASON,
  REFUND_COMPLETED_STATUS,
  REFUND_FAILED_STATUS,
  REFUND_PENDING_STATUS,
  REFUND_REVIEW_STATUS,
  RELEASE_REFUND_LEASE_RESULT,
  WORKER_MARK_CANCEL_REQUESTED_AT_RESULT,
  WORKER_RECORD_TRANSACTION_KEY_RESULT,
  WORKER_SETTLE_REFUND_RESULT,
} from "../refund.constants.js";
import { RefundRepository } from "./refund.repository.js";

const REFUND_ID = "550e8400-e29b-41d4-a716-446655440040";
const PAYMENT_ID = "550e8400-e29b-41d4-a716-446655440030";
const AMOUNT = 20_000;
const PAYMENT_KEY = "pay-key";
const TRANSACTION_KEY = "txn-key";
const OTHER_TRANSACTION_KEY = "txn-other";
const LEASE_TOKEN = "lease-token-1";
const OTHER_LEASE_TOKEN = "lease-token-2";
const NOW = new Date("2026-11-02T00:00:00.000Z");
const LEASE_UNTIL = new Date("2026-11-02T00:05:00.000Z");
const REQUESTED_AT = new Date("2026-10-25T00:00:00.000Z");
const EXPIRY_THRESHOLD = new Date(NOW.getTime() - REFUND_CANCEL_IDEMPOTENCY_TTL_MS);

const availableLeaseOr = [
  {
    leaseToken: null,
    leaseUntil: null,
  },
  {
    leaseToken: { not: null },
    leaseUntil: { lte: NOW },
  },
];

const workerPayableBookingWhere = {
  status: PAYMENT_PAID_STATUS,
  booking: {
    status: BOOKING_CANCELLED_STATUS,
  },
};


describe("RefundRepository.findByPaymentId", () => {
  it("returns the existing refund for a payment", async () => {
    const refundFindUnique = jest.fn<
      () => Promise<{
        id: string;
        paymentId: string;
        amount: number;
        status: string;
      } | null>
    >();
    refundFindUnique.mockResolvedValue({
      id: REFUND_ID,
      paymentId: PAYMENT_ID,
      amount: AMOUNT,
      status: REFUND_PENDING_STATUS,
    });
    const tx = {
      refund: { findUnique: refundFindUnique },
    } as unknown as Prisma.TransactionClient;

    await expect(
      new RefundRepository({} as PrismaService).findByPaymentId(tx, PAYMENT_ID),
    ).resolves.toEqual({
      id: REFUND_ID,
      paymentId: PAYMENT_ID,
      amount: AMOUNT,
      status: REFUND_PENDING_STATUS,
    });
    expect(refundFindUnique).toHaveBeenCalledWith({
      where: { paymentId: PAYMENT_ID },
      select: {
        id: true,
        paymentId: true,
        amount: true,
        status: true,
      },
    });
  });

  it("returns null when no refund exists for the payment", async () => {
    const refundFindUnique = jest.fn<() => Promise<null>>();
    refundFindUnique.mockResolvedValue(null);
    const tx = {
      refund: { findUnique: refundFindUnique },
    } as unknown as Prisma.TransactionClient;

    await expect(
      new RefundRepository({} as PrismaService).findByPaymentId(tx, PAYMENT_ID),
    ).resolves.toBeNull();
  });
});

describe("RefundRepository.createPendingRefund", () => {
  it("creates a pending refund with cancel snapshots and a generated idempotency key", async () => {
    const paymentFindUniqueOrThrow = jest.fn<
      () => Promise<{ paymentKey: string; amount: number }>
    >();
    paymentFindUniqueOrThrow.mockResolvedValue({
      paymentKey: PAYMENT_KEY,
      amount: AMOUNT,
    });
    const refundCreate = jest.fn<
      (args: {
        data: Record<string, unknown>;
      }) => Promise<Record<string, unknown>>
    >();
    refundCreate.mockResolvedValue({
      id: "refund-1",
      paymentId: PAYMENT_ID,
      amount: AMOUNT,
      status: REFUND_PENDING_STATUS,
      idempotencyKey: "generated",
      paymentKey: PAYMENT_KEY,
      cancelReason: REFUND_CANCEL_REASON,
    });
    const createTx = {
      payment: { findUniqueOrThrow: paymentFindUniqueOrThrow },
      refund: { create: refundCreate },
    } as unknown as Prisma.TransactionClient;

    await new RefundRepository({} as PrismaService).createPendingRefund(
      createTx,
      PAYMENT_ID,
      AMOUNT,
    );

    expect(paymentFindUniqueOrThrow).toHaveBeenCalledWith({
      where: { id: PAYMENT_ID },
      select: { paymentKey: true, amount: true },
    });
    expect(refundCreate).toHaveBeenCalledWith({
      data: {
        paymentId: PAYMENT_ID,
        amount: AMOUNT,
        status: REFUND_PENDING_STATUS,
        idempotencyKey: expect.any(String),
        paymentKey: PAYMENT_KEY,
        cancelReason: REFUND_CANCEL_REASON,
      },
      select: {
        id: true,
        paymentId: true,
        amount: true,
        status: true,
        idempotencyKey: true,
        paymentKey: true,
        cancelReason: true,
      },
    });
    const createdKey = refundCreate.mock.calls[0]?.[0].data.idempotencyKey;
    expect(typeof createdKey).toBe("string");
    expect(createdKey).not.toBe(PAYMENT_ID);
  });

  it("rejects refund creation when the payment has no paymentKey", async () => {
    const refundCreate = jest.fn();
    const createTx = {
      payment: {
        findUniqueOrThrow: jest
          .fn<() => Promise<{ paymentKey: string | null; amount: number }>>()
          .mockResolvedValue({
            paymentKey: null,
            amount: AMOUNT,
          }),
      },
      refund: { create: refundCreate },
    } as unknown as Prisma.TransactionClient;

    await expect(
      new RefundRepository({} as PrismaService).createPendingRefund(
        createTx,
        PAYMENT_ID,
        AMOUNT,
      ),
    ).rejects.toThrow("paymentKey");
    expect(refundCreate).not.toHaveBeenCalled();
  });
});

describe("RefundRepository.findDueRefundIds", () => {
  it("lists pending refunds with free or expired leases by createdAt then id", async () => {
    const findMany = jest.fn<() => Promise<{ id: string }[]>>().mockResolvedValue([
      { id: REFUND_ID },
    ]);
    const repository = new RefundRepository({
      client: { refund: { findMany } },
    } as unknown as PrismaService);

    await expect(repository.findDueRefundIds(NOW, 50)).resolves.toEqual([REFUND_ID]);
    expect(findMany).toHaveBeenCalledWith({
      where: {
        status: REFUND_PENDING_STATUS,
        OR: availableLeaseOr,
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 50,
      select: { id: true },
    });
  });
});

describe("RefundRepository.claimDue", () => {
  const claimedRow = {
    id: REFUND_ID,
    paymentId: PAYMENT_ID,
    amount: AMOUNT,
    paymentKey: PAYMENT_KEY,
    cancelReason: REFUND_CANCEL_REASON,
    idempotencyKey: "idem-1",
    cancelRequestedAt: null,
    transactionKey: null,
  };

  it("claims a pending refund with a free lease", async () => {
    const updateManyAndReturn = jest
      .fn<() => Promise<typeof claimedRow[]>>()
      .mockResolvedValue([claimedRow]);
    const tx = {
      refund: { updateManyAndReturn },
    } as unknown as Prisma.TransactionClient;

    const result = await new RefundRepository({} as PrismaService).claimDue(
      tx,
      REFUND_ID,
      NOW,
      LEASE_TOKEN,
      LEASE_UNTIL,
    );

    expect(updateManyAndReturn).toHaveBeenCalledWith({
      where: {
        id: REFUND_ID,
        status: REFUND_PENDING_STATUS,
        OR: availableLeaseOr,
      },
      data: {
        leaseToken: LEASE_TOKEN,
        leaseUntil: LEASE_UNTIL,
      },
      select: expect.any(Object),
    });
    expect(result).toEqual({
      result: CLAIM_REFUND_RESULT.CLAIMED,
      refund: {
        ...claimedRow,
        leaseToken: LEASE_TOKEN,
        leaseUntil: LEASE_UNTIL,
      },
    });
  });

  it("does not claim when another worker already holds the lease", async () => {
    const updateManyAndReturn = jest.fn<() => Promise<unknown[]>>().mockResolvedValue([]);
    const tx = {
      refund: { updateManyAndReturn },
    } as unknown as Prisma.TransactionClient;

    await expect(
      new RefundRepository({} as PrismaService).claimDue(
        tx,
        REFUND_ID,
        NOW,
        LEASE_TOKEN,
        LEASE_UNTIL,
      ),
    ).resolves.toEqual({ result: CLAIM_REFUND_RESULT.NOT_CLAIMED });
  });

  it("allows reclaim after the previous lease expired", async () => {
    const updateManyAndReturn = jest.fn<
      (args: { where: { OR: unknown } }) => Promise<typeof claimedRow[]>
    >().mockResolvedValue([claimedRow]);
    const tx = {
      refund: { updateManyAndReturn },
    } as unknown as Prisma.TransactionClient;

    const result = await new RefundRepository({} as PrismaService).claimDue(
      tx,
      REFUND_ID,
      NOW,
      OTHER_LEASE_TOKEN,
      LEASE_UNTIL,
    );

    expect(result.result).toBe(CLAIM_REFUND_RESULT.CLAIMED);
    expect(updateManyAndReturn.mock.calls[0]?.[0].where.OR).toEqual(availableLeaseOr);
  });

  it("lets only one of two concurrent claims succeed", async () => {
    const updateManyAndReturn = jest
      .fn<() => Promise<typeof claimedRow[]>>()
      .mockResolvedValueOnce([claimedRow])
      .mockResolvedValueOnce([]);
    const tx = {
      refund: { updateManyAndReturn },
    } as unknown as Prisma.TransactionClient;
    const repository = new RefundRepository({} as PrismaService);

    const first = await repository.claimDue(tx, REFUND_ID, NOW, LEASE_TOKEN, LEASE_UNTIL);
    const second = await repository.claimDue(tx, REFUND_ID, NOW, OTHER_LEASE_TOKEN, LEASE_UNTIL);

    expect(first.result).toBe(CLAIM_REFUND_RESULT.CLAIMED);
    expect(second).toEqual({ result: CLAIM_REFUND_RESULT.NOT_CLAIMED });
  });
});

describe("RefundRepository.releaseLease", () => {
  it("releases only when the lease token matches", async () => {
    const updateMany = jest.fn<() => Promise<{ count: number }>>().mockResolvedValue({
      count: 1,
    });
    const tx = {
      refund: { updateMany, findUnique: jest.fn() },
    } as unknown as Prisma.TransactionClient;

    const result = await new RefundRepository({} as PrismaService).releaseLease(
      tx,
      REFUND_ID,
      LEASE_TOKEN,
    );

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: REFUND_ID,
        leaseToken: LEASE_TOKEN,
      },
      data: {
        leaseToken: null,
        leaseUntil: null,
      },
    });
    expect(result).toEqual({ result: RELEASE_REFUND_LEASE_RESULT.RELEASED });
  });

  it("does not release another worker lease", async () => {
    const updateMany = jest.fn<() => Promise<{ count: number }>>().mockResolvedValue({
      count: 0,
    });
    const findUnique = jest.fn<() => Promise<{ id: string } | null>>().mockResolvedValue({
      id: REFUND_ID,
    });
    const tx = {
      refund: { updateMany, findUnique },
    } as unknown as Prisma.TransactionClient;

    await expect(
      new RefundRepository({} as PrismaService).releaseLease(tx, REFUND_ID, LEASE_TOKEN),
    ).resolves.toEqual({ result: RELEASE_REFUND_LEASE_RESULT.NOT_HELD });
  });
});

describe("RefundRepository.workerMarkCancelRequestedAt", () => {
  it("records cancelRequestedAt only while the worker holds the lease", async () => {
    const updateMany = jest.fn<() => Promise<{ count: number }>>().mockResolvedValue({
      count: 1,
    });
    const tx = {
      refund: { updateMany, findUnique: jest.fn() },
    } as unknown as Prisma.TransactionClient;

    const result = await new RefundRepository({} as PrismaService).workerMarkCancelRequestedAt(
      tx,
      REFUND_ID,
      LEASE_TOKEN,
      NOW,
      REQUESTED_AT,
    );

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: REFUND_ID,
        status: REFUND_PENDING_STATUS,
        leaseToken: LEASE_TOKEN,
        leaseUntil: { gt: NOW },
        cancelRequestedAt: null,
      },
      data: {
        cancelRequestedAt: REQUESTED_AT,
      },
    });
    expect(result).toEqual({
      result: WORKER_MARK_CANCEL_REQUESTED_AT_RESULT.MARKED,
      cancelRequestedAt: REQUESTED_AT,
    });
  });

  it("keeps an already recorded cancelRequestedAt immutable", async () => {
    const updateMany = jest.fn<() => Promise<{ count: number }>>().mockResolvedValue({
      count: 0,
    });
    const findUnique = jest.fn<() => Promise<{
      status: string;
      cancelRequestedAt: Date | null;
      leaseToken: string | null;
      leaseUntil: Date | null;
    }>>().mockResolvedValue({
      status: REFUND_PENDING_STATUS,
      cancelRequestedAt: REQUESTED_AT,
      leaseToken: LEASE_TOKEN,
      leaseUntil: LEASE_UNTIL,
    });
    const tx = {
      refund: { updateMany, findUnique },
    } as unknown as Prisma.TransactionClient;

    const result = await new RefundRepository({} as PrismaService).workerMarkCancelRequestedAt(
      tx,
      REFUND_ID,
      LEASE_TOKEN,
      NOW,
      NOW,
    );

    expect(result).toEqual({
      result: WORKER_MARK_CANCEL_REQUESTED_AT_RESULT.ALREADY_SET,
      cancelRequestedAt: REQUESTED_AT,
    });
  });

  it("rejects mark when the lease token no longer matches", async () => {
    const updateMany = jest.fn<() => Promise<{ count: number }>>().mockResolvedValue({
      count: 0,
    });
    const findUnique = jest.fn<() => Promise<{
      status: string;
      cancelRequestedAt: Date | null;
      leaseToken: string | null;
      leaseUntil: Date | null;
    }>>().mockResolvedValue({
      status: REFUND_PENDING_STATUS,
      cancelRequestedAt: null,
      leaseToken: OTHER_LEASE_TOKEN,
      leaseUntil: LEASE_UNTIL,
    });
    const tx = {
      refund: { updateMany, findUnique },
    } as unknown as Prisma.TransactionClient;

    await expect(
      new RefundRepository({} as PrismaService).workerMarkCancelRequestedAt(
        tx,
        REFUND_ID,
        LEASE_TOKEN,
        NOW,
        REQUESTED_AT,
      ),
    ).resolves.toEqual({ result: WORKER_MARK_CANCEL_REQUESTED_AT_RESULT.NOT_HELD });
  });
});

describe("RefundRepository.workerRecordTransactionKey", () => {
  let updateMany: jest.MockedFunction<
    (args: { where: unknown; data: unknown }) => Promise<{ count: number }>
  >;
  let findUnique: jest.MockedFunction<() => Promise<Record<string, unknown> | null>>;
  let tx: Prisma.TransactionClient;
  let repository: RefundRepository;

  beforeEach(() => {
    updateMany = jest.fn();
    findUnique = jest.fn();
    tx = { refund: { updateMany, findUnique } } as unknown as Prisma.TransactionClient;
    repository = new RefundRepository({} as PrismaService);
  });

  it("records a transactionKey under the held lease without changing status", async () => {
    updateMany.mockResolvedValue({ count: 1 });

    const result = await repository.workerRecordTransactionKey(
      tx,
      REFUND_ID,
      LEASE_TOKEN,
      NOW,
      TRANSACTION_KEY,
    );

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: REFUND_ID,
        status: REFUND_PENDING_STATUS,
        leaseToken: LEASE_TOKEN,
        leaseUntil: { gt: NOW },
        transactionKey: null,
        cancelRequestedAt: { not: null },
        payment: workerPayableBookingWhere,
      },
      data: {
        transactionKey: TRANSACTION_KEY,
      },
    });
    expect(result).toEqual({ result: WORKER_RECORD_TRANSACTION_KEY_RESULT.RECORDED });
  });

  it("does not record a transactionKey when cancelRequestedAt is missing", async () => {
    updateMany.mockResolvedValue({ count: 0 });
    findUnique.mockResolvedValue({
      status: REFUND_PENDING_STATUS,
      transactionKey: null,
      leaseToken: LEASE_TOKEN,
      leaseUntil: LEASE_UNTIL,
    });

    await expect(
      repository.workerRecordTransactionKey(tx, REFUND_ID, LEASE_TOKEN, NOW, TRANSACTION_KEY),
    ).resolves.toEqual({ result: WORKER_RECORD_TRANSACTION_KEY_RESULT.NOT_PENDING });
    expect(updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        cancelRequestedAt: { not: null },
      }),
      data: expect.any(Object),
    });
  });

  it("returns already recorded for the same key", async () => {
    updateMany.mockResolvedValue({ count: 0 });
    findUnique.mockResolvedValue({
      status: REFUND_PENDING_STATUS,
      transactionKey: TRANSACTION_KEY,
      leaseToken: LEASE_TOKEN,
      leaseUntil: LEASE_UNTIL,
    });

    await expect(
      repository.workerRecordTransactionKey(tx, REFUND_ID, LEASE_TOKEN, NOW, TRANSACTION_KEY),
    ).resolves.toEqual({ result: WORKER_RECORD_TRANSACTION_KEY_RESULT.ALREADY_RECORDED });
  });

  it("returns key conflict for a different stored key", async () => {
    updateMany.mockResolvedValue({ count: 0 });
    findUnique.mockResolvedValue({
      status: REFUND_PENDING_STATUS,
      transactionKey: TRANSACTION_KEY,
      leaseToken: LEASE_TOKEN,
      leaseUntil: LEASE_UNTIL,
    });

    await expect(
      repository.workerRecordTransactionKey(
        tx,
        REFUND_ID,
        LEASE_TOKEN,
        NOW,
        OTHER_TRANSACTION_KEY,
      ),
    ).resolves.toEqual({ result: WORKER_RECORD_TRANSACTION_KEY_RESULT.KEY_CONFLICT });
  });

  it("returns key conflict when another refund already owns the key", async () => {
    updateMany.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "test",
        meta: { target: ["transactionKey"] },
      }),
    );

    await expect(
      repository.workerRecordTransactionKey(tx, REFUND_ID, LEASE_TOKEN, NOW, TRANSACTION_KEY),
    ).resolves.toEqual({ result: WORKER_RECORD_TRANSACTION_KEY_RESULT.KEY_CONFLICT });
  });

  it("does not record when the lease belongs to another worker", async () => {
    updateMany.mockResolvedValue({ count: 0 });
    findUnique.mockResolvedValue({
      status: REFUND_PENDING_STATUS,
      transactionKey: null,
      leaseToken: OTHER_LEASE_TOKEN,
      leaseUntil: LEASE_UNTIL,
    });

    await expect(
      repository.workerRecordTransactionKey(tx, REFUND_ID, LEASE_TOKEN, NOW, TRANSACTION_KEY),
    ).resolves.toEqual({ result: WORKER_RECORD_TRANSACTION_KEY_RESULT.NOT_HELD });
  });
});

describe("RefundRepository.worker settle transitions", () => {
  let updateMany: jest.MockedFunction<
    (args: { where: unknown; data: unknown }) => Promise<{ count: number }>
  >;
  let findUnique: jest.MockedFunction<() => Promise<Record<string, unknown> | null>>;
  let findUniqueOrThrow: jest.MockedFunction<() => Promise<Record<string, unknown>>>;
  let tx: Prisma.TransactionClient;
  let repository: RefundRepository;

  beforeEach(() => {
    updateMany = jest.fn();
    findUnique = jest.fn();
    findUniqueOrThrow = jest.fn();
    tx = {
      refund: { updateMany, findUnique, findUniqueOrThrow },
    } as unknown as Prisma.TransactionClient;
    repository = new RefundRepository({} as PrismaService);
  });

  it("completes a pending refund with transactionKey and clears the lease", async () => {
    updateMany.mockResolvedValue({ count: 1 });
    findUniqueOrThrow.mockResolvedValue({
      id: REFUND_ID,
      paymentId: PAYMENT_ID,
      status: REFUND_COMPLETED_STATUS,
      amount: AMOUNT,
      completedAt: NOW,
      failedAt: null,
      transactionKey: TRANSACTION_KEY,
    });

    const result = await repository.workerCompletePendingRefund(
      tx,
      REFUND_ID,
      LEASE_TOKEN,
      NOW,
    );

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: REFUND_ID,
        status: REFUND_PENDING_STATUS,
        leaseToken: LEASE_TOKEN,
        leaseUntil: { gt: NOW },
        transactionKey: { not: null },
        payment: workerPayableBookingWhere,
      },
      data: {
        status: REFUND_COMPLETED_STATUS,
        completedAt: NOW,
        leaseToken: null,
        leaseUntil: null,
      },
    });
    expect(result.result).toBe(WORKER_SETTLE_REFUND_RESULT.COMPLETED);
  });

  it("fails only when transactionKey is still null", async () => {
    updateMany.mockResolvedValue({ count: 1 });
    findUniqueOrThrow.mockResolvedValue({
      id: REFUND_ID,
      paymentId: PAYMENT_ID,
      status: REFUND_FAILED_STATUS,
      amount: AMOUNT,
      completedAt: null,
      failedAt: NOW,
      transactionKey: null,
    });

    const result = await repository.workerFailPendingRefund(tx, REFUND_ID, LEASE_TOKEN, NOW);

    expect(updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        transactionKey: null,
      }),
      data: expect.objectContaining({
        status: REFUND_FAILED_STATUS,
        leaseToken: null,
        leaseUntil: null,
      }),
    });
    expect(result.result).toBe(WORKER_SETTLE_REFUND_RESULT.FAILED);
  });

  it("marks expired pending refunds as REVIEW regardless of transactionKey", async () => {
    updateMany.mockResolvedValue({ count: 1 });
    findUniqueOrThrow.mockResolvedValue({
      id: REFUND_ID,
      paymentId: PAYMENT_ID,
      status: REFUND_REVIEW_STATUS,
      amount: AMOUNT,
      completedAt: null,
      failedAt: null,
      transactionKey: TRANSACTION_KEY,
    });

    const result = await repository.workerReviewExpiredPendingRefund(
      tx,
      REFUND_ID,
      LEASE_TOKEN,
      NOW,
      EXPIRY_THRESHOLD,
    );

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: REFUND_ID,
        status: REFUND_PENDING_STATUS,
        leaseToken: LEASE_TOKEN,
        leaseUntil: { gt: NOW },
        cancelRequestedAt: { lte: EXPIRY_THRESHOLD },
        payment: workerPayableBookingWhere,
      },
      data: {
        status: REFUND_REVIEW_STATUS,
        leaseToken: null,
        leaseUntil: null,
      },
    });
    expect(updateMany.mock.calls[0]?.[0].where).not.toHaveProperty("transactionKey");
    expect(result.result).toBe(WORKER_SETTLE_REFUND_RESULT.REVIEWED);
  });

  it("marks NOT_CANCELED pending refunds with transactionKey as REVIEW", async () => {
    updateMany.mockResolvedValue({ count: 1 });
    findUniqueOrThrow.mockResolvedValue({
      id: REFUND_ID,
      paymentId: PAYMENT_ID,
      status: REFUND_REVIEW_STATUS,
      amount: AMOUNT,
      completedAt: null,
      failedAt: null,
      transactionKey: TRANSACTION_KEY,
    });

    const result = await repository.workerReviewNotCanceledPendingRefund(
      tx,
      REFUND_ID,
      LEASE_TOKEN,
      NOW,
    );

    expect(updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        transactionKey: { not: null },
      }),
      data: {
        status: REFUND_REVIEW_STATUS,
        leaseToken: null,
        leaseUntil: null,
      },
    });
    expect(result.result).toBe(WORKER_SETTLE_REFUND_RESULT.REVIEWED);
  });

  it("rejects settle when another worker holds the lease", async () => {
    updateMany.mockResolvedValue({ count: 0 });
    findUnique.mockResolvedValue({
      id: REFUND_ID,
      leaseToken: OTHER_LEASE_TOKEN,
      leaseUntil: LEASE_UNTIL,
    });

    await expect(
      repository.workerCompletePendingRefund(tx, REFUND_ID, LEASE_TOKEN, NOW),
    ).resolves.toEqual({ result: WORKER_SETTLE_REFUND_RESULT.NOT_HELD });
  });

  it("does not mutate legacy COMPLETED refunds that lack a transactionKey", async () => {
    updateMany.mockResolvedValue({ count: 0 });
    findUnique.mockResolvedValue({
      id: REFUND_ID,
      leaseToken: null,
      leaseUntil: null,
    });

    await expect(
      repository.workerCompletePendingRefund(tx, REFUND_ID, LEASE_TOKEN, NOW),
    ).resolves.toEqual({ result: WORKER_SETTLE_REFUND_RESULT.NOT_HELD });
    expect(updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        status: REFUND_PENDING_STATUS,
      }),
      data: expect.any(Object),
    });
  });
});

