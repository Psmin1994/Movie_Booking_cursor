import { randomUUID } from "node:crypto";
import { Injectable, InternalServerErrorException } from "@nestjs/common";
import { Prisma } from "@movie-booking/database-prisma";
import { PrismaService } from "../../database/prisma.service.js";
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
import { automaticRetryDeadlineAt, nextAutomaticProcessAt } from "../reconciliation-schedule.js";

type ReconciliationTransaction = Prisma.TransactionClient;

type OpenReconciliation = {
  id: string;
  paymentId: string;
  createdAt: Date;
  nextProcessAt: Date | null;
};

type ClaimedReconciliation = {
  id: string;
  paymentId: string;
  leaseToken: string;
  leaseUntil: Date;
};

export type ClaimReconciliationResult =
  | {
      result: typeof CLAIM_RECONCILIATION_RESULT.CLAIMED;
      reconciliation: ClaimedReconciliation;
    }
  | { result: typeof CLAIM_RECONCILIATION_RESULT.NOT_CLAIMED };

export type CompleteReconciliationAsNotPaidResult =
  | { result: typeof COMPLETE_RECONCILIATION_AS_NOT_PAID_RESULT.COMPLETED }
  | { result: typeof COMPLETE_RECONCILIATION_AS_NOT_PAID_RESULT.NOT_FOUND }
  | { result: typeof COMPLETE_RECONCILIATION_AS_NOT_PAID_RESULT.NOT_HELD };

export type CompleteReconciliationAsRefundCreatedResult =
  | { result: typeof COMPLETE_RECONCILIATION_AS_REFUND_CREATED_RESULT.COMPLETED }
  | { result: typeof COMPLETE_RECONCILIATION_AS_REFUND_CREATED_RESULT.NOT_FOUND }
  | { result: typeof COMPLETE_RECONCILIATION_AS_REFUND_CREATED_RESULT.NOT_HELD };

export type RescheduleReconciliationAfterUnknownResult =
  | { result: typeof RESCHEDULE_RECONCILIATION_AFTER_UNKNOWN_RESULT.RESCHEDULED }
  | { result: typeof RESCHEDULE_RECONCILIATION_AFTER_UNKNOWN_RESULT.NOT_FOUND }
  | { result: typeof RESCHEDULE_RECONCILIATION_AFTER_UNKNOWN_RESULT.NOT_HELD };

export type MarkReconciliationReviewPastDeadlineResult =
  | { result: typeof MARK_RECONCILIATION_REVIEW_PAST_DEADLINE_RESULT.REVIEWED }
  | { result: typeof MARK_RECONCILIATION_REVIEW_PAST_DEADLINE_RESULT.NOT_ELIGIBLE };

export type MarkReconciliationReviewForIdentityMismatchResult =
  | { result: typeof MARK_RECONCILIATION_REVIEW_FOR_IDENTITY_MISMATCH_RESULT.REVIEWED }
  | { result: typeof MARK_RECONCILIATION_REVIEW_FOR_IDENTITY_MISMATCH_RESULT.NOT_FOUND }
  | { result: typeof MARK_RECONCILIATION_REVIEW_FOR_IDENTITY_MISMATCH_RESULT.NOT_HELD };

export type ReleaseReconciliationLeaseResult =
  | { result: typeof RELEASE_RECONCILIATION_LEASE_RESULT.RELEASED }
  | { result: typeof RELEASE_RECONCILIATION_LEASE_RESULT.NOT_FOUND }
  | { result: typeof RELEASE_RECONCILIATION_LEASE_RESULT.NOT_HELD };

@Injectable()
export class ReconcilePaymentRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findDueIds(now: Date, limit: number): Promise<string[]> {
    const reconciliations = await this.prisma.client.paymentReconciliation.findMany({
      where: {
        status: RECONCILIATION_SCHEDULED_STATUS,
        nextProcessAt: { lte: now },
        retryDeadline: { gt: now },
        OR: availableLeaseOr(now),
      },
      orderBy: [{ nextProcessAt: "asc" }, { id: "asc" }],
      take: limit,
      select: { id: true },
    });

    return reconciliations.map((reconciliation) => reconciliation.id);
  }

  async findPastDeadlineIds(now: Date, limit: number): Promise<string[]> {
    const reconciliations = await this.prisma.client.paymentReconciliation.findMany({
      where: {
        status: RECONCILIATION_SCHEDULED_STATUS,
        retryDeadline: { lte: now },
        OR: pastDeadlineLeaseOr(now),
      },
      orderBy: [{ retryDeadline: "asc" }, { id: "asc" }],
      take: limit,
      select: { id: true },
    });

    return reconciliations.map((reconciliation) => reconciliation.id);
  }

  createOpen(tx: ReconciliationTransaction, paymentId: string, openedAt: Date): Promise<OpenReconciliation> {
    return tx.paymentReconciliation.create({
      data: {
        paymentId,
        status: RECONCILIATION_SCHEDULED_STATUS,
        createdAt: openedAt,
        nextProcessAt: openedAt,
        retryDeadline: automaticRetryDeadlineAt(openedAt),
      },
      select: {
        id: true,
        paymentId: true,
        createdAt: true,
        nextProcessAt: true,
      },
    });
  }

  async claimDue(
    tx: ReconciliationTransaction,
    reconciliationId: string,
    now: Date,
  ): Promise<ClaimReconciliationResult> {
    const leaseToken = randomUUID();
    const leaseUntil = new Date(now.getTime() + RECONCILIATION_LEASE_TTL_MS);
    const claimed = await tx.paymentReconciliation.updateManyAndReturn({
      where: {
        id: reconciliationId,
        status: RECONCILIATION_SCHEDULED_STATUS,
        nextProcessAt: { lte: now },
        retryDeadline: { gt: now },
        OR: availableLeaseOr(now),
      },
      data: {
        leaseToken,
        leaseUntil,
      },
      select: {
        id: true,
        paymentId: true,
      },
    });

    if (claimed.length === 0) {
      return { result: CLAIM_RECONCILIATION_RESULT.NOT_CLAIMED };
    }

    if (claimed.length > 1) {
      throw new InternalServerErrorException();
    }

    const reconciliation = claimed[0];

    if (!reconciliation) {
      throw new InternalServerErrorException();
    }

    return {
      result: CLAIM_RECONCILIATION_RESULT.CLAIMED,
      reconciliation: {
        id: reconciliation.id,
        paymentId: reconciliation.paymentId,
        leaseToken,
        leaseUntil,
      },
    };
  }

  async releaseLease(
    tx: ReconciliationTransaction,
    reconciliationId: string,
    leaseToken: string,
    now: Date,
  ): Promise<ReleaseReconciliationLeaseResult> {
    const released = await tx.paymentReconciliation.updateMany({
      where: {
        id: reconciliationId,
        leaseToken,
        leaseUntil: { gt: now },
      },
      data: {
        leaseToken: null,
        leaseUntil: null,
      },
    });

    if (released.count === 1) {
      return { result: RELEASE_RECONCILIATION_LEASE_RESULT.RELEASED };
    }

    const existing = await tx.paymentReconciliation.findUnique({
      where: { id: reconciliationId },
      select: { id: true },
    });

    if (!existing) {
      return { result: RELEASE_RECONCILIATION_LEASE_RESULT.NOT_FOUND };
    }

    return { result: RELEASE_RECONCILIATION_LEASE_RESULT.NOT_HELD };
  }

  async completeAsNotPaid(
    tx: ReconciliationTransaction,
    reconciliationId: string,
    leaseToken: string,
    completedAt: Date,
  ): Promise<CompleteReconciliationAsNotPaidResult> {
    const completed = await tx.paymentReconciliation.updateMany({
      where: {
        id: reconciliationId,
        status: RECONCILIATION_SCHEDULED_STATUS,
        leaseToken,
        leaseUntil: { gt: completedAt },
      },
      data: {
        status: RECONCILIATION_COMPLETED_STATUS,
        result: RECONCILIATION_RESULT_NOT_PAID,
        completedAt,
        leaseToken: null,
        leaseUntil: null,
      },
    });

    if (completed.count === 1) {
      return { result: COMPLETE_RECONCILIATION_AS_NOT_PAID_RESULT.COMPLETED };
    }

    const existing = await tx.paymentReconciliation.findUnique({
      where: { id: reconciliationId },
      select: { id: true },
    });

    if (!existing) {
      return { result: COMPLETE_RECONCILIATION_AS_NOT_PAID_RESULT.NOT_FOUND };
    }

    return { result: COMPLETE_RECONCILIATION_AS_NOT_PAID_RESULT.NOT_HELD };
  }

  async completeAsRefundCreated(
    tx: ReconciliationTransaction,
    reconciliationId: string,
    leaseToken: string,
    completedAt: Date,
  ): Promise<CompleteReconciliationAsRefundCreatedResult> {
    const completed = await tx.paymentReconciliation.updateMany({
      where: {
        id: reconciliationId,
        status: RECONCILIATION_SCHEDULED_STATUS,
        leaseToken,
        leaseUntil: { gt: completedAt },
      },
      data: {
        status: RECONCILIATION_COMPLETED_STATUS,
        result: RECONCILIATION_RESULT_REFUND_CREATED,
        completedAt,
        leaseToken: null,
        leaseUntil: null,
      },
    });

    if (completed.count === 1) {
      return { result: COMPLETE_RECONCILIATION_AS_REFUND_CREATED_RESULT.COMPLETED };
    }

    const existing = await tx.paymentReconciliation.findUnique({
      where: { id: reconciliationId },
      select: { id: true },
    });

    if (!existing) {
      return { result: COMPLETE_RECONCILIATION_AS_REFUND_CREATED_RESULT.NOT_FOUND };
    }

    return { result: COMPLETE_RECONCILIATION_AS_REFUND_CREATED_RESULT.NOT_HELD };
  }

  async markReviewForIdentityMismatch(
    tx: ReconciliationTransaction,
    reconciliationId: string,
    leaseToken: string,
    now: Date,
  ): Promise<MarkReconciliationReviewForIdentityMismatchResult> {
    const marked = await tx.paymentReconciliation.updateMany({
      where: {
        id: reconciliationId,
        status: RECONCILIATION_SCHEDULED_STATUS,
        leaseToken,
        leaseUntil: { gt: now },
      },
      data: {
        status: RECONCILIATION_REVIEW_STATUS,
        result: RECONCILIATION_RESULT_IDENTITY_MISMATCH,
        leaseToken: null,
        leaseUntil: null,
      },
    });

    if (marked.count === 1) {
      return { result: MARK_RECONCILIATION_REVIEW_FOR_IDENTITY_MISMATCH_RESULT.REVIEWED };
    }

    const existing = await tx.paymentReconciliation.findUnique({
      where: { id: reconciliationId },
      select: { id: true },
    });

    if (!existing) {
      return { result: MARK_RECONCILIATION_REVIEW_FOR_IDENTITY_MISMATCH_RESULT.NOT_FOUND };
    }

    return { result: MARK_RECONCILIATION_REVIEW_FOR_IDENTITY_MISMATCH_RESULT.NOT_HELD };
  }

  async rescheduleAfterUnknown(
    tx: ReconciliationTransaction,
    reconciliationId: string,
    leaseToken: string,
    processedAt: Date,
  ): Promise<RescheduleReconciliationAfterUnknownResult> {
    const rescheduled = await tx.paymentReconciliation.updateMany({
      where: {
        id: reconciliationId,
        status: RECONCILIATION_SCHEDULED_STATUS,
        leaseToken,
        leaseUntil: { gt: processedAt },
      },
      data: {
        nextProcessAt: nextAutomaticProcessAt(processedAt),
      },
    });

    if (rescheduled.count === 1) {
      return { result: RESCHEDULE_RECONCILIATION_AFTER_UNKNOWN_RESULT.RESCHEDULED };
    }

    const existing = await tx.paymentReconciliation.findUnique({
      where: { id: reconciliationId },
      select: { id: true },
    });

    if (!existing) {
      return { result: RESCHEDULE_RECONCILIATION_AFTER_UNKNOWN_RESULT.NOT_FOUND };
    }

    return { result: RESCHEDULE_RECONCILIATION_AFTER_UNKNOWN_RESULT.NOT_HELD };
  }

  async markReviewPastDeadline(
    tx: ReconciliationTransaction,
    reconciliationId: string,
    now: Date,
  ): Promise<MarkReconciliationReviewPastDeadlineResult> {
    const marked = await tx.paymentReconciliation.updateMany({
      where: {
        id: reconciliationId,
        status: RECONCILIATION_SCHEDULED_STATUS,
        retryDeadline: { lte: now },
        OR: pastDeadlineLeaseOr(now),
      },
      data: {
        status: RECONCILIATION_REVIEW_STATUS,
        result: RECONCILIATION_RESULT_UNRESOLVED,
        leaseToken: null,
        leaseUntil: null,
      },
    });

    if (marked.count === 1) {
      return { result: MARK_RECONCILIATION_REVIEW_PAST_DEADLINE_RESULT.REVIEWED };
    }

    return { result: MARK_RECONCILIATION_REVIEW_PAST_DEADLINE_RESULT.NOT_ELIGIBLE };
  }
}

function availableLeaseOr(now: Date): Prisma.PaymentReconciliationWhereInput[] {
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

function pastDeadlineLeaseOr(now: Date): Prisma.PaymentReconciliationWhereInput[] {
  return [
    {
      leaseToken: null,
      leaseUntil: null,
    },
    {
      leaseToken: { not: null },
      leaseUntil: { not: null, lte: now },
    },
  ];
}
