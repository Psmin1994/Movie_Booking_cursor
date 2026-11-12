import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { Prisma } from "@movie-booking/database-prisma";
import { BOOKING_CANCELLED_STATUS } from "../../booking/booking.constants.js";
import { PrismaService } from "../../database/prisma.service.js";
import { PAYMENT_PAID_STATUS } from "../../payment/payment.constants.js";
import {
  CLAIM_REFUND_RESULT,
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

type RefundTransaction = Prisma.TransactionClient;

export type SettledRefund = {
  id: string;
  paymentId: string;
  status: string;
  amount: number;
  completedAt: Date | null;
  failedAt: Date | null;
  transactionKey: string | null;
};

export type ClaimedRefund = {
  id: string;
  paymentId: string;
  amount: number;
  paymentKey: string;
  cancelReason: string;
  idempotencyKey: string;
  cancelRequestedAt: Date | null;
  transactionKey: string | null;
  leaseToken: string;
  leaseUntil: Date;
};

export type ClaimRefundResult =
  | { result: typeof CLAIM_REFUND_RESULT.CLAIMED; refund: ClaimedRefund }
  | { result: typeof CLAIM_REFUND_RESULT.NOT_CLAIMED };

export type ReleaseRefundLeaseResult =
  | { result: typeof RELEASE_REFUND_LEASE_RESULT.RELEASED }
  | { result: typeof RELEASE_REFUND_LEASE_RESULT.NOT_FOUND }
  | { result: typeof RELEASE_REFUND_LEASE_RESULT.NOT_HELD };

export type WorkerMarkCancelRequestedAtResult =
  | {
      result: typeof WORKER_MARK_CANCEL_REQUESTED_AT_RESULT.MARKED;
      cancelRequestedAt: Date;
    }
  | {
      result: typeof WORKER_MARK_CANCEL_REQUESTED_AT_RESULT.ALREADY_SET;
      cancelRequestedAt: Date;
    }
  | { result: typeof WORKER_MARK_CANCEL_REQUESTED_AT_RESULT.NOT_FOUND }
  | { result: typeof WORKER_MARK_CANCEL_REQUESTED_AT_RESULT.NOT_PENDING }
  | { result: typeof WORKER_MARK_CANCEL_REQUESTED_AT_RESULT.NOT_HELD };

export type WorkerRecordTransactionKeyResult =
  | { result: typeof WORKER_RECORD_TRANSACTION_KEY_RESULT.RECORDED }
  | { result: typeof WORKER_RECORD_TRANSACTION_KEY_RESULT.ALREADY_RECORDED }
  | { result: typeof WORKER_RECORD_TRANSACTION_KEY_RESULT.KEY_CONFLICT }
  | { result: typeof WORKER_RECORD_TRANSACTION_KEY_RESULT.NOT_FOUND }
  | { result: typeof WORKER_RECORD_TRANSACTION_KEY_RESULT.NOT_PENDING }
  | { result: typeof WORKER_RECORD_TRANSACTION_KEY_RESULT.NOT_HELD };

export type WorkerSettleRefundResult =
  | {
      result:
        | typeof WORKER_SETTLE_REFUND_RESULT.COMPLETED
        | typeof WORKER_SETTLE_REFUND_RESULT.FAILED
        | typeof WORKER_SETTLE_REFUND_RESULT.REVIEWED;
      refund: SettledRefund;
    }
  | { result: typeof WORKER_SETTLE_REFUND_RESULT.NOT_FOUND }
  | { result: typeof WORKER_SETTLE_REFUND_RESULT.NOT_PENDING }
  | { result: typeof WORKER_SETTLE_REFUND_RESULT.NOT_HELD };

const SETTLED_REFUND_SELECT = {
  id: true,
  paymentId: true,
  status: true,
  amount: true,
  completedAt: true,
  failedAt: true,
  transactionKey: true,
} as const;

const CLAIMED_REFUND_SELECT = {
  id: true,
  paymentId: true,
  amount: true,
  paymentKey: true,
  cancelReason: true,
  idempotencyKey: true,
  cancelRequestedAt: true,
  transactionKey: true,
} as const;

@Injectable()
export class RefundRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByPaymentId(tx: RefundTransaction, paymentId: string) {
    return tx.refund.findUnique({
      where: { paymentId },
      select: {
        id: true,
        paymentId: true,
        amount: true,
        status: true,
      },
    });
  }

  async createPendingRefund(tx: RefundTransaction, paymentId: string, amount: number) {
    const payment = await tx.payment.findUniqueOrThrow({
      where: { id: paymentId },
      select: { paymentKey: true, amount: true },
    });

    if (payment.paymentKey === null) {
      throw new Error("Cannot create a refund without a paymentKey snapshot.");
    }

    if (payment.amount !== amount) {
      throw new Error("Cannot create a refund whose amount differs from the payment amount.");
    }

    return tx.refund.create({
      data: {
        paymentId,
        amount,
        status: REFUND_PENDING_STATUS,
        idempotencyKey: randomUUID(),
        paymentKey: payment.paymentKey,
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
  }

  async findDueRefundIds(now: Date, limit: number): Promise<string[]> {
    const refunds = await this.prisma.client.refund.findMany({
      where: {
        status: REFUND_PENDING_STATUS,
        OR: availableLeaseOr(now),
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: limit,
      select: { id: true },
    });

    return refunds.map((refund) => refund.id);
  }

  async claimDue(
    tx: RefundTransaction,
    refundId: string,
    now: Date,
    leaseToken: string,
    leaseUntil: Date,
  ): Promise<ClaimRefundResult> {
    const claimed = await tx.refund.updateManyAndReturn({
      where: {
        id: refundId,
        status: REFUND_PENDING_STATUS,
        OR: availableLeaseOr(now),
      },
      data: {
        leaseToken,
        leaseUntil,
      },
      select: CLAIMED_REFUND_SELECT,
    });

    if (claimed.length === 0) {
      return { result: CLAIM_REFUND_RESULT.NOT_CLAIMED };
    }

    const refund = claimed[0];
    if (claimed.length !== 1 || !refund) {
      throw new Error("Refund claimDue updated more than one row.");
    }

    return {
      result: CLAIM_REFUND_RESULT.CLAIMED,
      refund: {
        ...refund,
        leaseToken,
        leaseUntil,
      },
    };
  }

  async releaseLease(
    tx: RefundTransaction,
    refundId: string,
    leaseToken: string,
  ): Promise<ReleaseRefundLeaseResult> {
    const released = await tx.refund.updateMany({
      where: {
        id: refundId,
        leaseToken,
      },
      data: {
        leaseToken: null,
        leaseUntil: null,
      },
    });

    if (released.count === 1) {
      return { result: RELEASE_REFUND_LEASE_RESULT.RELEASED };
    }

    const refund = await tx.refund.findUnique({
      where: { id: refundId },
      select: { id: true },
    });

    if (!refund) {
      return { result: RELEASE_REFUND_LEASE_RESULT.NOT_FOUND };
    }

    return { result: RELEASE_REFUND_LEASE_RESULT.NOT_HELD };
  }

  async workerMarkCancelRequestedAt(
    tx: RefundTransaction,
    refundId: string,
    leaseToken: string,
    now: Date,
    requestedAt: Date,
  ): Promise<WorkerMarkCancelRequestedAtResult> {
    const marked = await tx.refund.updateMany({
      where: {
        ...workerHeldPendingWhere(refundId, leaseToken, now),
        cancelRequestedAt: null,
      },
      data: {
        cancelRequestedAt: requestedAt,
      },
    });

    if (marked.count === 1) {
      return {
        result: WORKER_MARK_CANCEL_REQUESTED_AT_RESULT.MARKED,
        cancelRequestedAt: requestedAt,
      };
    }

    return this.classifyWorkerMarkCancelRequestedAt(tx, refundId, leaseToken, now);
  }

  async workerRecordTransactionKey(
    tx: RefundTransaction,
    refundId: string,
    leaseToken: string,
    now: Date,
    transactionKey: string,
  ): Promise<WorkerRecordTransactionKeyResult> {
    const normalizedKey = transactionKey.trim();
    if (normalizedKey.length === 0) {
      return { result: WORKER_RECORD_TRANSACTION_KEY_RESULT.NOT_PENDING };
    }

    try {
      const recorded = await tx.refund.updateMany({
        where: {
          ...workerHeldPendingWhere(refundId, leaseToken, now),
          transactionKey: null,
          cancelRequestedAt: { not: null },
          payment: workerPayableBookingWhere(),
        },
        data: {
          transactionKey: normalizedKey,
        },
      });

      if (recorded.count === 1) {
        return { result: WORKER_RECORD_TRANSACTION_KEY_RESULT.RECORDED };
      }
    } catch (error) {
      if (isTransactionKeyUniqueViolation(error)) {
        return { result: WORKER_RECORD_TRANSACTION_KEY_RESULT.KEY_CONFLICT };
      }
      throw error;
    }

    return this.classifyWorkerRecordTransactionKey(
      tx,
      refundId,
      leaseToken,
      now,
      normalizedKey,
    );
  }

  async workerCompletePendingRefund(
    tx: RefundTransaction,
    refundId: string,
    leaseToken: string,
    now: Date,
  ): Promise<WorkerSettleRefundResult> {
    return this.workerSettle(
      tx,
      refundId,
      leaseToken,
      now,
      {
        transactionKey: { not: null },
      },
      {
        status: REFUND_COMPLETED_STATUS,
        completedAt: now,
        leaseToken: null,
        leaseUntil: null,
      },
      WORKER_SETTLE_REFUND_RESULT.COMPLETED,
      true,
    );
  }

  async workerFailPendingRefund(
    tx: RefundTransaction,
    refundId: string,
    leaseToken: string,
    now: Date,
  ): Promise<WorkerSettleRefundResult> {
    return this.workerSettle(
      tx,
      refundId,
      leaseToken,
      now,
      {
        transactionKey: null,
      },
      {
        status: REFUND_FAILED_STATUS,
        failedAt: now,
        leaseToken: null,
        leaseUntil: null,
      },
      WORKER_SETTLE_REFUND_RESULT.FAILED,
      false,
    );
  }

  async workerReviewExpiredPendingRefund(
    tx: RefundTransaction,
    refundId: string,
    leaseToken: string,
    now: Date,
    expiryThreshold: Date,
  ): Promise<WorkerSettleRefundResult> {
    return this.workerSettle(
      tx,
      refundId,
      leaseToken,
      now,
      {
        // Applies whether or not transactionKey is set (Cancel-path or Retrieve UNKNOWN expiry).
        // NULL cancelRequestedAt never satisfies lte.
        cancelRequestedAt: { lte: expiryThreshold },
      },
      {
        status: REFUND_REVIEW_STATUS,
        leaseToken: null,
        leaseUntil: null,
      },
      WORKER_SETTLE_REFUND_RESULT.REVIEWED,
      false,
    );
  }

  async workerReviewNotCanceledPendingRefund(
    tx: RefundTransaction,
    refundId: string,
    leaseToken: string,
    now: Date,
  ): Promise<WorkerSettleRefundResult> {
    return this.workerSettle(
      tx,
      refundId,
      leaseToken,
      now,
      {
        transactionKey: { not: null },
      },
      {
        status: REFUND_REVIEW_STATUS,
        leaseToken: null,
        leaseUntil: null,
      },
      WORKER_SETTLE_REFUND_RESULT.REVIEWED,
      true,
    );
  }

  private async workerSettle(
    tx: RefundTransaction,
    refundId: string,
    leaseToken: string,
    now: Date,
    extraWhere: Prisma.RefundWhereInput,
    data: Prisma.RefundUpdateManyMutationInput,
    successResult:
      | typeof WORKER_SETTLE_REFUND_RESULT.COMPLETED
      | typeof WORKER_SETTLE_REFUND_RESULT.FAILED
      | typeof WORKER_SETTLE_REFUND_RESULT.REVIEWED,
    requireTransactionKey: boolean,
  ): Promise<WorkerSettleRefundResult> {
    const settled = await tx.refund.updateMany({
      where: {
        ...workerHeldPendingWhere(refundId, leaseToken, now),
        ...extraWhere,
        payment: workerPayableBookingWhere(),
      },
      data,
    });

    if (settled.count === 1) {
      const refund = await tx.refund.findUniqueOrThrow({
        where: { id: refundId },
        select: SETTLED_REFUND_SELECT,
      });

      if (requireTransactionKey && refund.transactionKey === null) {
        throw new Error("Settled refund is missing transactionKey.");
      }

      return { result: successResult, refund };
    }

    return this.classifyWorkerSettleMiss(tx, refundId, leaseToken, now);
  }

  private async classifyWorkerMarkCancelRequestedAt(
    tx: RefundTransaction,
    refundId: string,
    leaseToken: string,
    now: Date,
  ): Promise<WorkerMarkCancelRequestedAtResult> {
    const refund = await tx.refund.findUnique({
      where: { id: refundId },
      select: {
        status: true,
        cancelRequestedAt: true,
        leaseToken: true,
        leaseUntil: true,
      },
    });

    if (!refund) {
      return { result: WORKER_MARK_CANCEL_REQUESTED_AT_RESULT.NOT_FOUND };
    }

    if (!holdsWorkerLease(refund, leaseToken, now)) {
      return { result: WORKER_MARK_CANCEL_REQUESTED_AT_RESULT.NOT_HELD };
    }

    if (refund.status !== REFUND_PENDING_STATUS) {
      return { result: WORKER_MARK_CANCEL_REQUESTED_AT_RESULT.NOT_PENDING };
    }

    if (refund.cancelRequestedAt === null) {
      return { result: WORKER_MARK_CANCEL_REQUESTED_AT_RESULT.NOT_PENDING };
    }

    return {
      result: WORKER_MARK_CANCEL_REQUESTED_AT_RESULT.ALREADY_SET,
      cancelRequestedAt: refund.cancelRequestedAt,
    };
  }

  private async classifyWorkerRecordTransactionKey(
    tx: RefundTransaction,
    refundId: string,
    leaseToken: string,
    now: Date,
    normalizedKey: string,
  ): Promise<WorkerRecordTransactionKeyResult> {
    const refund = await tx.refund.findUnique({
      where: { id: refundId },
      select: {
        status: true,
        transactionKey: true,
        leaseToken: true,
        leaseUntil: true,
      },
    });

    if (!refund) {
      return { result: WORKER_RECORD_TRANSACTION_KEY_RESULT.NOT_FOUND };
    }

    if (!holdsWorkerLease(refund, leaseToken, now)) {
      return { result: WORKER_RECORD_TRANSACTION_KEY_RESULT.NOT_HELD };
    }

    if (refund.status !== REFUND_PENDING_STATUS) {
      return { result: WORKER_RECORD_TRANSACTION_KEY_RESULT.NOT_PENDING };
    }

    if (refund.transactionKey === normalizedKey) {
      return { result: WORKER_RECORD_TRANSACTION_KEY_RESULT.ALREADY_RECORDED };
    }

    if (refund.transactionKey !== null) {
      return { result: WORKER_RECORD_TRANSACTION_KEY_RESULT.KEY_CONFLICT };
    }

    return { result: WORKER_RECORD_TRANSACTION_KEY_RESULT.NOT_PENDING };
  }

  private async classifyWorkerSettleMiss(
    tx: RefundTransaction,
    refundId: string,
    leaseToken: string,
    now: Date,
  ): Promise<WorkerSettleRefundResult> {
    const refund = await tx.refund.findUnique({
      where: { id: refundId },
      select: {
        id: true,
        leaseToken: true,
        leaseUntil: true,
      },
    });

    if (!refund) {
      return { result: WORKER_SETTLE_REFUND_RESULT.NOT_FOUND };
    }

    if (!holdsWorkerLease(refund, leaseToken, now)) {
      return { result: WORKER_SETTLE_REFUND_RESULT.NOT_HELD };
    }

    return { result: WORKER_SETTLE_REFUND_RESULT.NOT_PENDING };
  }
}

function availableLeaseOr(now: Date): Prisma.RefundWhereInput[] {
  return [
    {
      leaseToken: null,
      leaseUntil: null,
    },
    {
      leaseToken: { not: null },
      leaseUntil: { lte: now },
    },
  ];
}

function workerHeldPendingWhere(
  refundId: string,
  leaseToken: string,
  now: Date,
): Prisma.RefundWhereInput {
  return {
    id: refundId,
    status: REFUND_PENDING_STATUS,
    leaseToken,
    leaseUntil: { gt: now },
  };
}

function workerPayableBookingWhere(): Prisma.PaymentWhereInput {
  return {
    status: PAYMENT_PAID_STATUS,
    booking: {
      status: BOOKING_CANCELLED_STATUS,
    },
  };
}

function holdsWorkerLease(
  refund: { leaseToken: string | null; leaseUntil: Date | null },
  leaseToken: string,
  now: Date,
): boolean {
  return (
    refund.leaseToken === leaseToken &&
    refund.leaseUntil !== null &&
    refund.leaseUntil.getTime() > now.getTime()
  );
}

function isTransactionKeyUniqueViolation(error: unknown): boolean {
  if (
    !(error instanceof Prisma.PrismaClientKnownRequestError) ||
    error.code !== "P2002"
  ) {
    return false;
  }

  const target = error.meta?.target;

  if (target == null) {
    return false;
  }

  if (typeof target === "string") {
    return target.includes("transactionKey");
  }

  return Array.isArray(target) && target.includes("transactionKey");
}
