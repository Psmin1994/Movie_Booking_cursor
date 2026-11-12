import { randomUUID } from "node:crypto";
import { Injectable, InternalServerErrorException } from "@nestjs/common";
import { PrismaService } from "../../database/prisma.service.js";
import {
  PaymentGateway,
  type PaymentGatewayCancelResult,
  type PaymentGatewayRetrieveCancelOutcomeResult,
} from "../../payment/gateway/payment-gateway.js";
import {
  CLAIM_REFUND_RESULT,
  PROCESS_REFUND_RESULT,
  REFUND_CANCEL_IDEMPOTENCY_TTL_MS,
  REFUND_LEASE_TTL_MS,
  RELEASE_REFUND_LEASE_RESULT,
  WORKER_MARK_CANCEL_REQUESTED_AT_RESULT,
  WORKER_RECORD_TRANSACTION_KEY_RESULT,
  WORKER_SETTLE_REFUND_RESULT,
} from "../refund.constants.js";
import {
  RefundRepository,
  type ClaimedRefund,
} from "../repository/refund.repository.js";

export type ProcessRefundResult =
  | { result: typeof PROCESS_REFUND_RESULT.COMPLETED }
  | { result: typeof PROCESS_REFUND_RESULT.FAILED }
  | { result: typeof PROCESS_REFUND_RESULT.REVIEWED }
  | { result: typeof PROCESS_REFUND_RESULT.PENDING }
  | { result: typeof PROCESS_REFUND_RESULT.NOT_CLAIMED };

type ClaimedSnapshot = Pick<
  ClaimedRefund,
  | "paymentKey"
  | "amount"
  | "cancelReason"
  | "idempotencyKey"
  | "cancelRequestedAt"
  | "transactionKey"
>;

@Injectable()
export class ProcessRefundService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly refundRepository: RefundRepository,
    private readonly paymentGateway: PaymentGateway,
  ) {}

  async execute(refundId: string): Promise<ProcessRefundResult> {
    const now = new Date(Date.now());
    const leaseToken = randomUUID();
    const leaseUntil = new Date(now.getTime() + REFUND_LEASE_TTL_MS);

    const claimed = await this.prisma.client.$transaction((tx) =>
      this.refundRepository.claimDue(tx, refundId, now, leaseToken, leaseUntil),
    );

    if (claimed.result !== CLAIM_REFUND_RESULT.CLAIMED) {
      return { result: PROCESS_REFUND_RESULT.NOT_CLAIMED };
    }

    const snapshot: ClaimedSnapshot = claimed.refund;

    if (snapshot.transactionKey !== null) {
      return this.processWithTransactionKey(
        refundId,
        leaseToken,
        now,
        snapshot,
        snapshot.transactionKey,
      );
    }

    return this.processWithoutTransactionKey(refundId, leaseToken, now, snapshot);
  }

  private async processWithoutTransactionKey(
    refundId: string,
    leaseToken: string,
    now: Date,
    snapshot: ClaimedSnapshot,
  ): Promise<ProcessRefundResult> {
    const marked = await this.prisma.client.$transaction((tx) =>
      this.refundRepository.workerMarkCancelRequestedAt(
        tx,
        refundId,
        leaseToken,
        now,
        now,
      ),
    );

    if (
      marked.result !== WORKER_MARK_CANCEL_REQUESTED_AT_RESULT.MARKED &&
      marked.result !== WORKER_MARK_CANCEL_REQUESTED_AT_RESULT.ALREADY_SET
    ) {
      throw new InternalServerErrorException();
    }

    const cancelRequestedAt = marked.cancelRequestedAt;

    if (isCancelIdempotencyExpired(cancelRequestedAt, now)) {
      return this.reviewExpired(refundId, leaseToken, now);
    }

    const cancelResult = await this.paymentGateway.cancel({
      paymentKey: snapshot.paymentKey,
      cancelReason: snapshot.cancelReason,
      cancelAmount: snapshot.amount,
      idempotencyKey: snapshot.idempotencyKey,
    });

    if (cancelResult.status === "UNKNOWN") {
      return this.releaseAndKeepPending(refundId, leaseToken);
    }

    if (cancelResult.status === "FAILED") {
      return this.failPending(refundId, leaseToken, now);
    }

    if (!isValidCancelSuccess(cancelResult, snapshot)) {
      return this.releaseAndKeepPending(refundId, leaseToken);
    }

    const recorded = await this.prisma.client.$transaction((tx) =>
      this.refundRepository.workerRecordTransactionKey(
        tx,
        refundId,
        leaseToken,
        now,
        cancelResult.transactionKey,
      ),
    );

    if (
      recorded.result !== WORKER_RECORD_TRANSACTION_KEY_RESULT.RECORDED &&
      recorded.result !== WORKER_RECORD_TRANSACTION_KEY_RESULT.ALREADY_RECORDED
    ) {
      if (recorded.result === WORKER_RECORD_TRANSACTION_KEY_RESULT.NOT_HELD) {
        throw new InternalServerErrorException();
      }
      return this.releaseAndKeepPending(refundId, leaseToken);
    }

    return this.processWithTransactionKey(
      refundId,
      leaseToken,
      now,
      {
        ...snapshot,
        cancelRequestedAt,
        transactionKey: cancelResult.transactionKey.trim(),
      },
      cancelResult.transactionKey.trim(),
    );
  }

  private async processWithTransactionKey(
    refundId: string,
    leaseToken: string,
    now: Date,
    snapshot: ClaimedSnapshot,
    transactionKey: string,
  ): Promise<ProcessRefundResult> {
    const retrieveResult = await this.paymentGateway.retrieveCancelOutcome({
      paymentKey: snapshot.paymentKey,
      transactionKey,
      cancelAmount: snapshot.amount,
    });

    if (retrieveResult.status === "NOT_CANCELED") {
      return this.reviewNotCanceled(refundId, leaseToken, now);
    }

    if (retrieveResult.status === "CANCELED") {
      if (!isValidCanceledOutcome(retrieveResult, snapshot, transactionKey)) {
        return this.releaseAndKeepPending(refundId, leaseToken);
      }
      return this.completePending(refundId, leaseToken, now);
    }

    // UNKNOWN: expiry uses the original cancelRequestedAt only.
    if (
      snapshot.cancelRequestedAt !== null &&
      isCancelIdempotencyExpired(snapshot.cancelRequestedAt, now)
    ) {
      return this.reviewExpired(refundId, leaseToken, now);
    }

    return this.releaseAndKeepPending(refundId, leaseToken);
  }

  private async reviewExpired(
    refundId: string,
    leaseToken: string,
    now: Date,
  ): Promise<ProcessRefundResult> {
    // cancelRequestedAt <= now - 168h ⇔ elapsed >= 168h
    const expiryThreshold = new Date(now.getTime() - REFUND_CANCEL_IDEMPOTENCY_TTL_MS);

    const reviewed = await this.prisma.client.$transaction((tx) =>
      this.refundRepository.workerReviewExpiredPendingRefund(
        tx,
        refundId,
        leaseToken,
        now,
        expiryThreshold,
      ),
    );

    if (reviewed.result !== WORKER_SETTLE_REFUND_RESULT.REVIEWED) {
      throw new InternalServerErrorException();
    }

    return { result: PROCESS_REFUND_RESULT.REVIEWED };
  }

  private async reviewNotCanceled(
    refundId: string,
    leaseToken: string,
    now: Date,
  ): Promise<ProcessRefundResult> {
    const reviewed = await this.prisma.client.$transaction((tx) =>
      this.refundRepository.workerReviewNotCanceledPendingRefund(
        tx,
        refundId,
        leaseToken,
        now,
      ),
    );

    if (reviewed.result !== WORKER_SETTLE_REFUND_RESULT.REVIEWED) {
      throw new InternalServerErrorException();
    }

    return { result: PROCESS_REFUND_RESULT.REVIEWED };
  }

  private async completePending(
    refundId: string,
    leaseToken: string,
    now: Date,
  ): Promise<ProcessRefundResult> {
    const completed = await this.prisma.client.$transaction((tx) =>
      this.refundRepository.workerCompletePendingRefund(tx, refundId, leaseToken, now),
    );

    if (completed.result !== WORKER_SETTLE_REFUND_RESULT.COMPLETED) {
      throw new InternalServerErrorException();
    }

    if (!completed.refund.completedAt) {
      throw new InternalServerErrorException();
    }

    return { result: PROCESS_REFUND_RESULT.COMPLETED };
  }

  private async failPending(
    refundId: string,
    leaseToken: string,
    now: Date,
  ): Promise<ProcessRefundResult> {
    const failed = await this.prisma.client.$transaction((tx) =>
      this.refundRepository.workerFailPendingRefund(tx, refundId, leaseToken, now),
    );

    if (failed.result !== WORKER_SETTLE_REFUND_RESULT.FAILED) {
      throw new InternalServerErrorException();
    }

    if (!failed.refund.failedAt) {
      throw new InternalServerErrorException();
    }

    return { result: PROCESS_REFUND_RESULT.FAILED };
  }

  private async releaseAndKeepPending(
    refundId: string,
    leaseToken: string,
  ): Promise<ProcessRefundResult> {
    const released = await this.prisma.client.$transaction((tx) =>
      this.refundRepository.releaseLease(tx, refundId, leaseToken),
    );

    if (
      released.result !== RELEASE_REFUND_LEASE_RESULT.RELEASED &&
      released.result !== RELEASE_REFUND_LEASE_RESULT.NOT_HELD
    ) {
      throw new InternalServerErrorException();
    }

    return { result: PROCESS_REFUND_RESULT.PENDING };
  }
}

export function isCancelIdempotencyExpired(
  cancelRequestedAt: Date,
  now: Date,
): boolean {
  return now.getTime() - cancelRequestedAt.getTime() >= REFUND_CANCEL_IDEMPOTENCY_TTL_MS;
}

function isValidCancelSuccess(
  gatewayResult: Extract<PaymentGatewayCancelResult, { status: "SUCCESS" }>,
  snapshot: ClaimedSnapshot,
): boolean {
  return (
    gatewayResult.paymentKey === snapshot.paymentKey &&
    gatewayResult.cancelAmount === snapshot.amount &&
    gatewayResult.transactionKey.trim().length > 0
  );
}

function isValidCanceledOutcome(
  gatewayResult: Extract<PaymentGatewayRetrieveCancelOutcomeResult, { status: "CANCELED" }>,
  snapshot: ClaimedSnapshot,
  transactionKey: string,
): boolean {
  return (
    gatewayResult.paymentKey === snapshot.paymentKey &&
    gatewayResult.cancelAmount === snapshot.amount &&
    gatewayResult.transactionKey === transactionKey
  );
}
