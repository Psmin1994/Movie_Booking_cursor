/**
 * Test Intent:
 * 대사 행 생성은 SCHEDULED 상태, 전달된 시작 시각, 동일 시각의 최초 처리 시각, 시작 10분 뒤 재시도 기한만 기록함을 보장한다.
 * Claim은 SCHEDULED이고 처리 시각이 도래했으며 재시도 기한이 남아 있고 Lease가 없거나 만료된 행만 새 토큰과 30초 Lease로 점유한다.
 * updateManyAndReturn 결과 길이가 0이면 NOT_CLAIMED, 1이면 CLAIMED, 2 이상이면 불변식 위반이다.
 * 반쪽 Lease는 미점유로 보지 않는다. Lease 해제는 유효한 소유 토큰이 일치할 때만 두 Lease 필드를 비운다.
 * findDueIds는 Claim과 동일한 자동 처리 가능 조건의 후보 ID만 nextProcessAt·id 순으로 limit만큼 조회한다.
 * completeAsNotPaid는 유효 Lease 소유권의 SCHEDULED 행만 COMPLETED·NOT_PAID로 바꾸고 Lease를 해제한다.
 * completeAsRefundCreated는 유효 Lease 소유권의 SCHEDULED 행만 COMPLETED·REFUND_CREATED로 바꾸고 Lease를 해제한다.
 * markReviewForIdentityMismatch는 유효 Lease 소유권의 SCHEDULED 행만 REVIEW·IDENTITY_MISMATCH로 바꾸고 Lease를 해제한다.
 * 토큰 불일치·Lease 만료·비-SCHEDULED면 변경하지 않는다.
 * rescheduleAfterUnknown은 유효 Lease의 SCHEDULED 행에 1분 뒤 nextProcessAt만 기록하고 result·Lease·retryDeadline·status는 유지한다.
 * markReviewPastDeadline은 SCHEDULED이고 retryDeadline이 도래했으며 Lease가 없거나 만료된 행만 REVIEW·UNRESOLVED로 바꾸고 만료 Lease 필드를 해제한다.
 * findPastDeadlineIds는 markReviewPastDeadline과 동일한 Lease·deadline 조건의 후보 ID만 retryDeadline·id 순으로 limit만큼 조회한다.
 * 활성·반쪽 Lease, 미래 deadline, 비-SCHEDULED면 변경하지 않는다.
 */

import { jest } from "@jest/globals";
import { InternalServerErrorException } from "@nestjs/common";
import { Prisma } from "@movie-booking/database-prisma";
import {
  CLAIM_RECONCILIATION_RESULT,
  COMPLETE_RECONCILIATION_AS_NOT_PAID_RESULT,
  COMPLETE_RECONCILIATION_AS_REFUND_CREATED_RESULT,
  MARK_RECONCILIATION_REVIEW_FOR_IDENTITY_MISMATCH_RESULT,
  MARK_RECONCILIATION_REVIEW_PAST_DEADLINE_RESULT,
  RECONCILIATION_COMPLETED_STATUS,
  RECONCILIATION_RESULT_IDENTITY_MISMATCH,
  RECONCILIATION_RESULT_NOT_PAID,
  RECONCILIATION_RESULT_REFUND_CREATED,
  RECONCILIATION_RESULT_UNRESOLVED,
  RECONCILIATION_LEASE_TTL_MS,
  RECONCILIATION_REVIEW_STATUS,
  RECONCILIATION_SCHEDULED_STATUS,
  RELEASE_RECONCILIATION_LEASE_RESULT,
  RESCHEDULE_RECONCILIATION_AFTER_UNKNOWN_RESULT,
} from "../payment.constants.js";
import { AUTOMATIC_RETRIEVE_INTERVAL_MS } from "../reconciliation-schedule.js";
import { ReconcilePaymentRepository } from "./reconcile-payment.repository.js";

const PAYMENT_ID = "550e8400-e29b-41d4-a716-446655440030";
const RECONCILIATION_ID = "550e8400-e29b-41d4-a716-446655440040";
const OPENED_AT = new Date("2026-10-14T00:00:00.000Z");
const NOW = new Date("2026-10-14T00:10:00.000Z");
const LEASE_TOKEN = "550e8400-e29b-41d4-a716-446655440050";
const OTHER_LEASE_TOKEN = "550e8400-e29b-41d4-a716-446655440051";

type Create = (args: {
  data: {
    paymentId: string;
    status: string;
    createdAt: Date;
    nextProcessAt: Date;
    retryDeadline: Date;
  };
}) => Promise<{
  id: string;
  paymentId: string;
  createdAt: Date;
  nextProcessAt: Date;
}>;

type UpdateManyAndReturn = (args: {
  where: unknown;
  data: unknown;
  select?: unknown;
}) => Promise<Array<{ id: string; paymentId: string }>>;

type UpdateMany = (args: {
  where: unknown;
  data: unknown;
}) => Promise<{ count: number }>;

type FindUnique = (args: {
  where: { id: string };
  select?: unknown;
}) => Promise<{ id: string; paymentId?: string } | null>;

describe("ReconcilePaymentRepository.createOpen", () => {
  it("stores the scheduled status, opening time, immediate first process time, and ten minute retry deadline without a lease", async () => {
    const create = jest.fn<Create>();
    create.mockResolvedValue({
      id: RECONCILIATION_ID,
      paymentId: PAYMENT_ID,
      createdAt: OPENED_AT,
      nextProcessAt: OPENED_AT,
    });
    const tx = {
      paymentReconciliation: { create },
    } as unknown as Prisma.TransactionClient;

    await new ReconcilePaymentRepository({} as never).createOpen(tx, PAYMENT_ID, OPENED_AT);

    expect(create).toHaveBeenCalledWith({
      data: {
        paymentId: PAYMENT_ID,
        status: RECONCILIATION_SCHEDULED_STATUS,
        createdAt: OPENED_AT,
        nextProcessAt: OPENED_AT,
        retryDeadline: new Date(OPENED_AT.getTime() + 10 * 60_000),
      },
      select: {
        id: true,
        paymentId: true,
        createdAt: true,
        nextProcessAt: true,
      },
    });
    expect(create.mock.calls[0]?.[0].data).not.toHaveProperty("result");
    expect(create.mock.calls[0]?.[0].data).not.toHaveProperty("leaseToken");
    expect(create.mock.calls[0]?.[0].data).not.toHaveProperty("leaseUntil");
    expect(create.mock.calls[0]?.[0].data).not.toHaveProperty("completedAt");
  });
});

describe("ReconcilePaymentRepository.claimDue", () => {
  let updateManyAndReturn: jest.MockedFunction<UpdateManyAndReturn>;
  let findUnique: jest.MockedFunction<FindUnique>;
  let findUniqueOrThrow: jest.MockedFunction<FindUnique>;
  let tx: Prisma.TransactionClient;
  let repository: ReconcilePaymentRepository;

  beforeEach(() => {
    updateManyAndReturn = jest.fn<UpdateManyAndReturn>();
    findUnique = jest.fn<FindUnique>();
    findUniqueOrThrow = jest.fn<FindUnique>();
    tx = {
      paymentReconciliation: {
        updateManyAndReturn,
        findUnique,
        findUniqueOrThrow,
      },
    } as unknown as Prisma.TransactionClient;
    repository = new ReconcilePaymentRepository({} as never);
  });

  it("claims a due scheduled reconciliation through updateManyAndReturn without a follow-up select", async () => {
    updateManyAndReturn.mockResolvedValue([{ id: RECONCILIATION_ID, paymentId: PAYMENT_ID }]);

    const result = await repository.claimDue(tx, RECONCILIATION_ID, NOW);

    expect(result.result).toBe(CLAIM_RECONCILIATION_RESULT.CLAIMED);
    if (result.result !== CLAIM_RECONCILIATION_RESULT.CLAIMED) {
      throw new Error("expected claim success");
    }
    expect(result.reconciliation).toEqual({
      id: RECONCILIATION_ID,
      paymentId: PAYMENT_ID,
      leaseToken: result.reconciliation.leaseToken,
      leaseUntil: new Date(NOW.getTime() + RECONCILIATION_LEASE_TTL_MS),
    });
    expect(result.reconciliation.leaseToken).toEqual(expect.any(String));
    expect(result.reconciliation.leaseToken.length).toBeGreaterThan(0);

    expect(updateManyAndReturn).toHaveBeenCalledWith({
      where: {
        id: RECONCILIATION_ID,
        status: RECONCILIATION_SCHEDULED_STATUS,
        nextProcessAt: { lte: NOW },
        retryDeadline: { gt: NOW },
        OR: [
          {
            leaseToken: null,
            leaseUntil: null,
          },
          {
            leaseToken: { not: null },
            leaseUntil: { lte: NOW },
          },
        ],
      },
      data: {
        leaseToken: result.reconciliation.leaseToken,
        leaseUntil: new Date(NOW.getTime() + RECONCILIATION_LEASE_TTL_MS),
      },
      select: {
        id: true,
        paymentId: true,
      },
    });
    const call = updateManyAndReturn.mock.calls[0]?.[0];
    expect(call?.data).not.toHaveProperty("status");
    expect(call?.data).not.toHaveProperty("result");
    expect(call?.data).not.toHaveProperty("nextProcessAt");
    expect(call?.data).not.toHaveProperty("retryDeadline");
    expect(call?.data).not.toHaveProperty("completedAt");
    expect(findUnique).not.toHaveBeenCalled();
    expect(findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it.each([
    ["exactly at the retry deadline", 0],
    ["after the retry deadline", 1],
  ])("requires retryDeadline after now when claiming (%s)", async (_label, offsetMs) => {
    updateManyAndReturn.mockResolvedValue([]);
    const claimAt = new Date(NOW.getTime() + offsetMs);

    await expect(repository.claimDue(tx, RECONCILIATION_ID, claimAt)).resolves.toEqual({
      result: CLAIM_RECONCILIATION_RESULT.NOT_CLAIMED,
    });
    expect(updateManyAndReturn).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          retryDeadline: { gt: claimAt },
        }),
      }),
    );
  });

  it("returns NOT_CLAIMED when updateManyAndReturn matches nothing", async () => {
    updateManyAndReturn.mockResolvedValue([]);

    await expect(repository.claimDue(tx, RECONCILIATION_ID, NOW)).resolves.toEqual({
      result: CLAIM_RECONCILIATION_RESULT.NOT_CLAIMED,
    });
    expect(findUnique).not.toHaveBeenCalled();
    expect(findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it("rejects when updateManyAndReturn returns more than one row", async () => {
    updateManyAndReturn.mockResolvedValue([
      { id: RECONCILIATION_ID, paymentId: PAYMENT_ID },
      { id: "550e8400-e29b-41d4-a716-446655440041", paymentId: "550e8400-e29b-41d4-a716-446655440031" },
    ]);

    await expect(repository.claimDue(tx, RECONCILIATION_ID, NOW)).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
    expect(findUnique).not.toHaveBeenCalled();
    expect(findUniqueOrThrow).not.toHaveBeenCalled();
  });
});

describe("ReconcilePaymentRepository.releaseLease", () => {
  let updateMany: jest.MockedFunction<UpdateMany>;
  let findUnique: jest.MockedFunction<FindUnique>;
  let tx: Prisma.TransactionClient;
  let repository: ReconcilePaymentRepository;

  beforeEach(() => {
    updateMany = jest.fn<UpdateMany>();
    findUnique = jest.fn<FindUnique>();
    tx = {
      paymentReconciliation: {
        updateMany,
        findUnique,
      },
    } as unknown as Prisma.TransactionClient;
    repository = new ReconcilePaymentRepository({} as never);
  });

  it("clears both lease fields only for the active owning token", async () => {
    updateMany.mockResolvedValue({ count: 1 });

    await expect(
      repository.releaseLease(tx, RECONCILIATION_ID, LEASE_TOKEN, NOW),
    ).resolves.toEqual({
      result: RELEASE_RECONCILIATION_LEASE_RESULT.RELEASED,
    });
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: RECONCILIATION_ID,
        leaseToken: LEASE_TOKEN,
        leaseUntil: { gt: NOW },
      },
      data: {
        leaseToken: null,
        leaseUntil: null,
      },
    });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("does not release another worker's lease when the token does not match", async () => {
    updateMany.mockResolvedValue({ count: 0 });
    findUnique.mockResolvedValue({ id: RECONCILIATION_ID });

    await expect(
      repository.releaseLease(tx, RECONCILIATION_ID, OTHER_LEASE_TOKEN, NOW),
    ).resolves.toEqual({
      result: RELEASE_RECONCILIATION_LEASE_RESULT.NOT_HELD,
    });
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: RECONCILIATION_ID,
        leaseToken: OTHER_LEASE_TOKEN,
        leaseUntil: { gt: NOW },
      },
      data: {
        leaseToken: null,
        leaseUntil: null,
      },
    });
  });

  it("reports missing reconciliation when the release target does not exist", async () => {
    updateMany.mockResolvedValue({ count: 0 });
    findUnique.mockResolvedValue(null);

    await expect(
      repository.releaseLease(tx, RECONCILIATION_ID, LEASE_TOKEN, NOW),
    ).resolves.toEqual({
      result: RELEASE_RECONCILIATION_LEASE_RESULT.NOT_FOUND,
    });
  });
});

describe("ReconcilePaymentRepository.completeAsNotPaid", () => {
  let updateMany: jest.MockedFunction<UpdateMany>;
  let findUnique: jest.MockedFunction<FindUnique>;
  let tx: Prisma.TransactionClient;
  let repository: ReconcilePaymentRepository;

  beforeEach(() => {
    updateMany = jest.fn<UpdateMany>();
    findUnique = jest.fn<FindUnique>();
    tx = {
      paymentReconciliation: {
        updateMany,
        findUnique,
      },
    } as unknown as Prisma.TransactionClient;
    repository = new ReconcilePaymentRepository({} as never);
  });

  it("completes a scheduled reconciliation as NOT_PAID and clears the lease", async () => {
    updateMany.mockResolvedValue({ count: 1 });

    await expect(
      repository.completeAsNotPaid(tx, RECONCILIATION_ID, LEASE_TOKEN, NOW),
    ).resolves.toEqual({
      result: COMPLETE_RECONCILIATION_AS_NOT_PAID_RESULT.COMPLETED,
    });
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: RECONCILIATION_ID,
        status: RECONCILIATION_SCHEDULED_STATUS,
        leaseToken: LEASE_TOKEN,
        leaseUntil: { gt: NOW },
      },
      data: {
        status: RECONCILIATION_COMPLETED_STATUS,
        result: RECONCILIATION_RESULT_NOT_PAID,
        completedAt: NOW,
        leaseToken: null,
        leaseUntil: null,
      },
    });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("does not complete when the lease token does not match", async () => {
    updateMany.mockResolvedValue({ count: 0 });
    findUnique.mockResolvedValue({ id: RECONCILIATION_ID });

    await expect(
      repository.completeAsNotPaid(tx, RECONCILIATION_ID, OTHER_LEASE_TOKEN, NOW),
    ).resolves.toEqual({
      result: COMPLETE_RECONCILIATION_AS_NOT_PAID_RESULT.NOT_HELD,
    });
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: RECONCILIATION_ID,
        status: RECONCILIATION_SCHEDULED_STATUS,
        leaseToken: OTHER_LEASE_TOKEN,
        leaseUntil: { gt: NOW },
      },
      data: {
        status: RECONCILIATION_COMPLETED_STATUS,
        result: RECONCILIATION_RESULT_NOT_PAID,
        completedAt: NOW,
        leaseToken: null,
        leaseUntil: null,
      },
    });
  });

  it("does not complete when the lease has expired", async () => {
    updateMany.mockResolvedValue({ count: 0 });
    findUnique.mockResolvedValue({ id: RECONCILIATION_ID });

    await expect(
      repository.completeAsNotPaid(tx, RECONCILIATION_ID, LEASE_TOKEN, NOW),
    ).resolves.toEqual({
      result: COMPLETE_RECONCILIATION_AS_NOT_PAID_RESULT.NOT_HELD,
    });
    expect(updateMany.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        where: expect.objectContaining({
          leaseUntil: { gt: NOW },
        }),
      }),
    );
  });

  it.each(["REVIEW", "COMPLETED"])("does not complete a %s reconciliation", async () => {
    updateMany.mockResolvedValue({ count: 0 });
    findUnique.mockResolvedValue({ id: RECONCILIATION_ID });

    await expect(
      repository.completeAsNotPaid(tx, RECONCILIATION_ID, LEASE_TOKEN, NOW),
    ).resolves.toEqual({
      result: COMPLETE_RECONCILIATION_AS_NOT_PAID_RESULT.NOT_HELD,
    });
    expect(updateMany.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        where: expect.objectContaining({
          status: RECONCILIATION_SCHEDULED_STATUS,
        }),
      }),
    );
  });

  it("reports missing reconciliation when the complete target does not exist", async () => {
    updateMany.mockResolvedValue({ count: 0 });
    findUnique.mockResolvedValue(null);

    await expect(
      repository.completeAsNotPaid(tx, RECONCILIATION_ID, LEASE_TOKEN, NOW),
    ).resolves.toEqual({
      result: COMPLETE_RECONCILIATION_AS_NOT_PAID_RESULT.NOT_FOUND,
    });
  });
});

describe("ReconcilePaymentRepository.completeAsRefundCreated", () => {
  let updateMany: jest.MockedFunction<UpdateMany>;
  let findUnique: jest.MockedFunction<FindUnique>;
  let tx: Prisma.TransactionClient;
  let repository: ReconcilePaymentRepository;

  beforeEach(() => {
    updateMany = jest.fn<UpdateMany>();
    findUnique = jest.fn<FindUnique>();
    tx = {
      paymentReconciliation: {
        updateMany,
        findUnique,
      },
    } as unknown as Prisma.TransactionClient;
    repository = new ReconcilePaymentRepository({} as never);
  });

  it("completes a scheduled reconciliation as REFUND_CREATED and clears the lease", async () => {
    updateMany.mockResolvedValue({ count: 1 });

    await expect(
      repository.completeAsRefundCreated(tx, RECONCILIATION_ID, LEASE_TOKEN, NOW),
    ).resolves.toEqual({
      result: COMPLETE_RECONCILIATION_AS_REFUND_CREATED_RESULT.COMPLETED,
    });
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: RECONCILIATION_ID,
        status: RECONCILIATION_SCHEDULED_STATUS,
        leaseToken: LEASE_TOKEN,
        leaseUntil: { gt: NOW },
      },
      data: {
        status: RECONCILIATION_COMPLETED_STATUS,
        result: RECONCILIATION_RESULT_REFUND_CREATED,
        completedAt: NOW,
        leaseToken: null,
        leaseUntil: null,
      },
    });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("does not complete when the lease token does not match", async () => {
    updateMany.mockResolvedValue({ count: 0 });
    findUnique.mockResolvedValue({ id: RECONCILIATION_ID });

    await expect(
      repository.completeAsRefundCreated(tx, RECONCILIATION_ID, OTHER_LEASE_TOKEN, NOW),
    ).resolves.toEqual({
      result: COMPLETE_RECONCILIATION_AS_REFUND_CREATED_RESULT.NOT_HELD,
    });
  });

  it("does not complete when the lease has expired", async () => {
    updateMany.mockResolvedValue({ count: 0 });
    findUnique.mockResolvedValue({ id: RECONCILIATION_ID });

    await expect(
      repository.completeAsRefundCreated(tx, RECONCILIATION_ID, LEASE_TOKEN, NOW),
    ).resolves.toEqual({
      result: COMPLETE_RECONCILIATION_AS_REFUND_CREATED_RESULT.NOT_HELD,
    });
    expect(updateMany.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        where: expect.objectContaining({
          leaseUntil: { gt: NOW },
        }),
      }),
    );
  });
});

describe("ReconcilePaymentRepository.markReviewForIdentityMismatch", () => {
  let updateMany: jest.MockedFunction<UpdateMany>;
  let findUnique: jest.MockedFunction<FindUnique>;
  let tx: Prisma.TransactionClient;
  let repository: ReconcilePaymentRepository;

  beforeEach(() => {
    updateMany = jest.fn<UpdateMany>();
    findUnique = jest.fn<FindUnique>();
    tx = {
      paymentReconciliation: {
        updateMany,
        findUnique,
      },
    } as unknown as Prisma.TransactionClient;
    repository = new ReconcilePaymentRepository({} as never);
  });

  it("marks a held scheduled reconciliation as REVIEW with IDENTITY_MISMATCH", async () => {
    updateMany.mockResolvedValue({ count: 1 });

    await expect(
      repository.markReviewForIdentityMismatch(tx, RECONCILIATION_ID, LEASE_TOKEN, NOW),
    ).resolves.toEqual({
      result: MARK_RECONCILIATION_REVIEW_FOR_IDENTITY_MISMATCH_RESULT.REVIEWED,
    });
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: RECONCILIATION_ID,
        status: RECONCILIATION_SCHEDULED_STATUS,
        leaseToken: LEASE_TOKEN,
        leaseUntil: { gt: NOW },
      },
      data: {
        status: RECONCILIATION_REVIEW_STATUS,
        result: RECONCILIATION_RESULT_IDENTITY_MISMATCH,
        leaseToken: null,
        leaseUntil: null,
      },
    });
  });

  it("does not mark review when the lease token does not match", async () => {
    updateMany.mockResolvedValue({ count: 0 });
    findUnique.mockResolvedValue({ id: RECONCILIATION_ID });

    await expect(
      repository.markReviewForIdentityMismatch(
        tx,
        RECONCILIATION_ID,
        OTHER_LEASE_TOKEN,
        NOW,
      ),
    ).resolves.toEqual({
      result: MARK_RECONCILIATION_REVIEW_FOR_IDENTITY_MISMATCH_RESULT.NOT_HELD,
    });
  });

  it("does not mark review when the lease has expired", async () => {
    updateMany.mockResolvedValue({ count: 0 });
    findUnique.mockResolvedValue({ id: RECONCILIATION_ID });

    await expect(
      repository.markReviewForIdentityMismatch(tx, RECONCILIATION_ID, LEASE_TOKEN, NOW),
    ).resolves.toEqual({
      result: MARK_RECONCILIATION_REVIEW_FOR_IDENTITY_MISMATCH_RESULT.NOT_HELD,
    });
  });
});

describe("ReconcilePaymentRepository.rescheduleAfterUnknown", () => {
  let updateMany: jest.MockedFunction<UpdateMany>;
  let findUnique: jest.MockedFunction<FindUnique>;
  let tx: Prisma.TransactionClient;
  let repository: ReconcilePaymentRepository;

  beforeEach(() => {
    updateMany = jest.fn<UpdateMany>();
    findUnique = jest.fn<FindUnique>();
    tx = {
      paymentReconciliation: {
        updateMany,
        findUnique,
      },
    } as unknown as Prisma.TransactionClient;
    repository = new ReconcilePaymentRepository({} as never);
  });

  it("records the next process time while keeping result and the lease", async () => {
    updateMany.mockResolvedValue({ count: 1 });

    await expect(
      repository.rescheduleAfterUnknown(tx, RECONCILIATION_ID, LEASE_TOKEN, NOW),
    ).resolves.toEqual({
      result: RESCHEDULE_RECONCILIATION_AFTER_UNKNOWN_RESULT.RESCHEDULED,
    });
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: RECONCILIATION_ID,
        status: RECONCILIATION_SCHEDULED_STATUS,
        leaseToken: LEASE_TOKEN,
        leaseUntil: { gt: NOW },
      },
      data: {
        nextProcessAt: new Date(NOW.getTime() + AUTOMATIC_RETRIEVE_INTERVAL_MS),
      },
    });
    const data = updateMany.mock.calls[0]?.[0].data as Record<string, unknown>;
    expect(data).not.toHaveProperty("result");
    expect(data).not.toHaveProperty("status");
    expect(data).not.toHaveProperty("leaseToken");
    expect(data).not.toHaveProperty("leaseUntil");
    expect(data).not.toHaveProperty("retryDeadline");
    expect(data).not.toHaveProperty("completedAt");
    expect(findUnique).not.toHaveBeenCalled();
  });

  it.each([
    ["before the retry deadline", 60_000],
    ["exactly at the retry deadline", 0],
    ["after the retry deadline", -1],
  ])("does not constrain retryDeadline when recording UNKNOWN (%s)", async (_label, offsetMs) => {
    updateMany.mockResolvedValue({ count: 1 });
    const processedAt = new Date(NOW.getTime() + offsetMs);

    await expect(
      repository.rescheduleAfterUnknown(tx, RECONCILIATION_ID, LEASE_TOKEN, processedAt),
    ).resolves.toEqual({
      result: RESCHEDULE_RECONCILIATION_AFTER_UNKNOWN_RESULT.RESCHEDULED,
    });
    expect(updateMany.mock.calls[0]?.[0].where).not.toHaveProperty("retryDeadline");
    expect(updateMany.mock.calls[0]?.[0].data).not.toHaveProperty("retryDeadline");
  });

  it("does not reschedule when the lease token does not match", async () => {
    updateMany.mockResolvedValue({ count: 0 });
    findUnique.mockResolvedValue({ id: RECONCILIATION_ID });

    await expect(
      repository.rescheduleAfterUnknown(tx, RECONCILIATION_ID, OTHER_LEASE_TOKEN, NOW),
    ).resolves.toEqual({
      result: RESCHEDULE_RECONCILIATION_AFTER_UNKNOWN_RESULT.NOT_HELD,
    });
  });

  it("does not reschedule when the lease has expired at processedAt", async () => {
    updateMany.mockResolvedValue({ count: 0 });
    findUnique.mockResolvedValue({ id: RECONCILIATION_ID });

    await expect(
      repository.rescheduleAfterUnknown(tx, RECONCILIATION_ID, LEASE_TOKEN, NOW),
    ).resolves.toEqual({
      result: RESCHEDULE_RECONCILIATION_AFTER_UNKNOWN_RESULT.NOT_HELD,
    });
    expect(updateMany.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        where: expect.objectContaining({
          leaseUntil: { gt: NOW },
        }),
      }),
    );
  });

  it.each(["REVIEW", "COMPLETED"])("does not reschedule a %s reconciliation", async () => {
    updateMany.mockResolvedValue({ count: 0 });
    findUnique.mockResolvedValue({ id: RECONCILIATION_ID });

    await expect(
      repository.rescheduleAfterUnknown(tx, RECONCILIATION_ID, LEASE_TOKEN, NOW),
    ).resolves.toEqual({
      result: RESCHEDULE_RECONCILIATION_AFTER_UNKNOWN_RESULT.NOT_HELD,
    });
    expect(updateMany.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        where: expect.objectContaining({
          status: RECONCILIATION_SCHEDULED_STATUS,
        }),
      }),
    );
  });

  it("reports missing reconciliation when the reschedule target does not exist", async () => {
    updateMany.mockResolvedValue({ count: 0 });
    findUnique.mockResolvedValue(null);

    await expect(
      repository.rescheduleAfterUnknown(tx, RECONCILIATION_ID, LEASE_TOKEN, NOW),
    ).resolves.toEqual({
      result: RESCHEDULE_RECONCILIATION_AFTER_UNKNOWN_RESULT.NOT_FOUND,
    });
  });
});

describe("ReconcilePaymentRepository.markReviewPastDeadline", () => {
  let updateMany: jest.MockedFunction<UpdateMany>;
  let findUnique: jest.MockedFunction<FindUnique>;
  let tx: Prisma.TransactionClient;
  let repository: ReconcilePaymentRepository;

  beforeEach(() => {
    updateMany = jest.fn<UpdateMany>();
    findUnique = jest.fn<FindUnique>();
    tx = {
      paymentReconciliation: {
        updateMany,
        findUnique,
      },
    } as unknown as Prisma.TransactionClient;
    repository = new ReconcilePaymentRepository({} as never);
  });

  it("marks a past-deadline scheduled reconciliation without an active lease as REVIEW with UNRESOLVED", async () => {
    updateMany.mockResolvedValue({ count: 1 });

    await expect(repository.markReviewPastDeadline(tx, RECONCILIATION_ID, NOW)).resolves.toEqual({
      result: MARK_RECONCILIATION_REVIEW_PAST_DEADLINE_RESULT.REVIEWED,
    });
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: RECONCILIATION_ID,
        status: RECONCILIATION_SCHEDULED_STATUS,
        retryDeadline: { lte: NOW },
        OR: [
          {
            leaseToken: null,
            leaseUntil: null,
          },
          {
            leaseToken: { not: null },
            leaseUntil: { not: null, lte: NOW },
          },
        ],
      },
      data: {
        status: RECONCILIATION_REVIEW_STATUS,
        result: RECONCILIATION_RESULT_UNRESOLVED,
        leaseToken: null,
        leaseUntil: null,
      },
    });
    const data = updateMany.mock.calls[0]?.[0].data as Record<string, unknown>;
    expect(data).not.toHaveProperty("nextProcessAt");
    expect(data).not.toHaveProperty("retryDeadline");
    expect(data).not.toHaveProperty("completedAt");
    expect(findUnique).not.toHaveBeenCalled();
  });

  it.each([
    ["exactly at the retry deadline", 0],
    ["after the retry deadline", -1],
  ])("marks review when retryDeadline is %s", async (_label, offsetMs) => {
    updateMany.mockResolvedValue({ count: 1 });
    const now = new Date(NOW.getTime() - offsetMs);

    await expect(repository.markReviewPastDeadline(tx, RECONCILIATION_ID, now)).resolves.toEqual({
      result: MARK_RECONCILIATION_REVIEW_PAST_DEADLINE_RESULT.REVIEWED,
    });
    expect(updateMany.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        where: expect.objectContaining({
          retryDeadline: { lte: now },
        }),
      }),
    );
  });

  it("does not mark review when retryDeadline is still in the future", async () => {
    updateMany.mockResolvedValue({ count: 0 });

    await expect(repository.markReviewPastDeadline(tx, RECONCILIATION_ID, NOW)).resolves.toEqual({
      result: MARK_RECONCILIATION_REVIEW_PAST_DEADLINE_RESULT.NOT_ELIGIBLE,
    });
    expect(updateMany.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        where: expect.objectContaining({
          retryDeadline: { lte: NOW },
        }),
      }),
    );
  });

  it("requires no lease or an expired full lease", async () => {
    updateMany.mockResolvedValue({ count: 1 });

    await repository.markReviewPastDeadline(tx, RECONCILIATION_ID, NOW);

    expect(updateMany.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            {
              leaseToken: null,
              leaseUntil: null,
            },
            {
              leaseToken: { not: null },
              leaseUntil: { not: null, lte: NOW },
            },
          ],
        }),
      }),
    );
  });

  it("does not mark review when an active lease still holds the row", async () => {
    updateMany.mockResolvedValue({ count: 0 });

    await expect(repository.markReviewPastDeadline(tx, RECONCILIATION_ID, NOW)).resolves.toEqual({
      result: MARK_RECONCILIATION_REVIEW_PAST_DEADLINE_RESULT.NOT_ELIGIBLE,
    });
  });

  it.each([
    {
      name: "token without until",
      leaseBranchNote: "half lease excluded by requiring both lease fields",
    },
    {
      name: "until without token",
      leaseBranchNote: "half lease excluded by requiring both lease fields",
    },
  ])("does not treat a half lease as eligible ($name)", async () => {
    updateMany.mockResolvedValue({ count: 0 });

    await expect(repository.markReviewPastDeadline(tx, RECONCILIATION_ID, NOW)).resolves.toEqual({
      result: MARK_RECONCILIATION_REVIEW_PAST_DEADLINE_RESULT.NOT_ELIGIBLE,
    });
    expect(updateMany.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            {
              leaseToken: null,
              leaseUntil: null,
            },
            {
              leaseToken: { not: null },
              leaseUntil: { not: null, lte: NOW },
            },
          ],
        }),
      }),
    );
  });

  it.each([RECONCILIATION_REVIEW_STATUS, RECONCILIATION_COMPLETED_STATUS])(
    "does not mark a %s reconciliation",
    async () => {
      updateMany.mockResolvedValue({ count: 0 });

      await expect(repository.markReviewPastDeadline(tx, RECONCILIATION_ID, NOW)).resolves.toEqual({
        result: MARK_RECONCILIATION_REVIEW_PAST_DEADLINE_RESULT.NOT_ELIGIBLE,
      });
      expect(updateMany.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({
          where: expect.objectContaining({
            status: RECONCILIATION_SCHEDULED_STATUS,
          }),
          data: {
            status: RECONCILIATION_REVIEW_STATUS,
            result: RECONCILIATION_RESULT_UNRESOLVED,
            leaseToken: null,
            leaseUntil: null,
          },
        }),
      );
    },
  );

  it("clears expired lease fields while leaving schedule fields untouched", async () => {
    updateMany.mockResolvedValue({ count: 1 });

    await repository.markReviewPastDeadline(tx, RECONCILIATION_ID, NOW);

    expect(updateMany.mock.calls[0]?.[0].data).toEqual({
      status: RECONCILIATION_REVIEW_STATUS,
      result: RECONCILIATION_RESULT_UNRESOLVED,
      leaseToken: null,
      leaseUntil: null,
    });
  });
});

describe("ReconcilePaymentRepository.findPastDeadlineIds", () => {
  it("finds scheduled past-deadline reconciliation ids without an active or half lease", async () => {
    const limit = 40;
    const findMany = jest.fn<(args: unknown) => Promise<{ id: string }[]>>();
    findMany.mockResolvedValue([{ id: RECONCILIATION_ID }]);
    const repositoryWithClient = new ReconcilePaymentRepository({
      client: {
        paymentReconciliation: {
          findMany,
        },
      },
    } as never);

    await expect(repositoryWithClient.findPastDeadlineIds(NOW, limit)).resolves.toEqual([
      RECONCILIATION_ID,
    ]);

    expect(findMany).toHaveBeenCalledWith({
      where: {
        status: RECONCILIATION_SCHEDULED_STATUS,
        retryDeadline: { lte: NOW },
        OR: [
          {
            leaseToken: null,
            leaseUntil: null,
          },
          {
            leaseToken: { not: null },
            leaseUntil: { not: null, lte: NOW },
          },
        ],
      },
      orderBy: [{ retryDeadline: "asc" }, { id: "asc" }],
      take: limit,
      select: { id: true },
    });
  });

  it.each([
    ["exactly at the retry deadline", 0],
    ["after the retry deadline", -1],
  ])("includes rows whose retryDeadline is %s", async (_label, offsetMs) => {
    const findAt = new Date(NOW.getTime() - offsetMs);
    const findMany = jest.fn<(args: unknown) => Promise<{ id: string }[]>>();
    findMany.mockResolvedValue([{ id: RECONCILIATION_ID }]);
    const repositoryWithClient = new ReconcilePaymentRepository({
      client: {
        paymentReconciliation: {
          findMany,
        },
      },
    } as never);

    await expect(repositoryWithClient.findPastDeadlineIds(findAt, 10)).resolves.toEqual([
      RECONCILIATION_ID,
    ]);
    expect(findMany.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        where: expect.objectContaining({
          retryDeadline: { lte: findAt },
        }),
      }),
    );
  });

  it("excludes rows whose retryDeadline is still in the future", async () => {
    const findMany = jest.fn<(args: unknown) => Promise<{ id: string }[]>>();
    findMany.mockResolvedValue([]);
    const repositoryWithClient = new ReconcilePaymentRepository({
      client: {
        paymentReconciliation: {
          findMany,
        },
      },
    } as never);

    await expect(repositoryWithClient.findPastDeadlineIds(NOW, 10)).resolves.toEqual([]);
    expect(findMany.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        where: expect.objectContaining({
          retryDeadline: { lte: NOW },
        }),
      }),
    );
  });
});

describe("ReconcilePaymentRepository.findDueIds", () => {
  it("finds scheduled due reconciliation ids within the retry deadline without an active or half lease", async () => {
    const limit = 25;
    const findMany = jest.fn<(args: unknown) => Promise<{ id: string }[]>>();
    const updateMany = jest.fn();
    const updateManyAndReturn = jest.fn();
    const deleteMany = jest.fn();
    findMany.mockResolvedValue([{ id: RECONCILIATION_ID }]);
    const repositoryWithClient = new ReconcilePaymentRepository({
      client: {
        paymentReconciliation: {
          findMany,
          updateMany,
          updateManyAndReturn,
          deleteMany,
        },
      },
    } as never);

    await expect(repositoryWithClient.findDueIds(NOW, limit)).resolves.toEqual([RECONCILIATION_ID]);

    expect(findMany).toHaveBeenCalledWith({
      where: {
        status: RECONCILIATION_SCHEDULED_STATUS,
        nextProcessAt: { lte: NOW },
        retryDeadline: { gt: NOW },
        OR: [
          {
            leaseToken: null,
            leaseUntil: null,
          },
          {
            leaseToken: { not: null },
            leaseUntil: { lte: NOW },
          },
        ],
      },
      orderBy: [{ nextProcessAt: "asc" }, { id: "asc" }],
      take: limit,
      select: { id: true },
    });
    expect(updateMany).not.toHaveBeenCalled();
    expect(updateManyAndReturn).not.toHaveBeenCalled();
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it.each([
    ["exactly at the retry deadline", 0],
    ["after the retry deadline", 1],
  ])("excludes rows whose retryDeadline is not after now (%s)", async (_label, offsetMs) => {
    const limit = 25;
    const findAt = new Date(NOW.getTime() + offsetMs);
    const findMany = jest.fn<(args: unknown) => Promise<{ id: string }[]>>();
    findMany.mockResolvedValue([]);
    const repositoryWithClient = new ReconcilePaymentRepository({
      client: {
        paymentReconciliation: {
          findMany,
          updateMany: jest.fn(),
          updateManyAndReturn: jest.fn(),
          deleteMany: jest.fn(),
        },
      },
    } as never);

    await expect(repositoryWithClient.findDueIds(findAt, limit)).resolves.toEqual([]);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          retryDeadline: { gt: findAt },
          nextProcessAt: { lte: findAt },
        }),
        orderBy: [{ nextProcessAt: "asc" }, { id: "asc" }],
        take: limit,
      }),
    );
  });
});
