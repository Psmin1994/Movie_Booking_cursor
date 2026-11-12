import { Injectable, InternalServerErrorException, Logger } from "@nestjs/common";
import { PrismaService } from "../../database/prisma.service.js";
import { RefundRepository } from "../../refund/repository/refund.repository.js";
import { ProcessRefundService } from "../../refund/use-case/process-refund.service.js";
import {
  PaymentGateway,
  type PaymentGatewayRetrieveResult,
} from "../gateway/payment-gateway.js";
import {
  CLAIM_RECONCILIATION_RESULT,
  COMPLETE_RECONCILIATION_AS_NOT_PAID_RESULT,
  COMPLETE_RECONCILIATION_AS_REFUND_CREATED_RESULT,
  FAIL_RECONCILIATION_PAYMENT_RESULT,
  MARK_RECONCILIATION_REVIEW_FOR_IDENTITY_MISMATCH_RESULT,
  PAY_RECONCILIATION_PAYMENT_RESULT,
  RECONCILE_PAYMENT_RESULT,
  RESCHEDULE_RECONCILIATION_AFTER_UNKNOWN_RESULT,
} from "../payment.constants.js";
import {
  PaymentRepository,
  type ReconciliationPayment,
} from "../repository/payment.repository.js";
import { ReconcilePaymentRepository } from "../repository/reconcile-payment.repository.js";

export type ReconcilePaymentResult =
  | { result: typeof RECONCILE_PAYMENT_RESULT.NOT_PAID }
  | { result: typeof RECONCILE_PAYMENT_RESULT.UNKNOWN }
  | { result: typeof RECONCILE_PAYMENT_RESULT.NOT_CLAIMED }
  | { result: typeof RECONCILE_PAYMENT_RESULT.PAID }
  | { result: typeof RECONCILE_PAYMENT_RESULT.IDENTITY_MISMATCH };

@Injectable()
export class ReconcilePaymentService {
  private readonly logger = new Logger(ReconcilePaymentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly paymentRepository: PaymentRepository,
    private readonly reconcilePaymentRepository: ReconcilePaymentRepository,
    private readonly refundRepository: RefundRepository,
    private readonly processRefundService: ProcessRefundService,
    private readonly paymentGateway: PaymentGateway,
  ) {}

  async execute(reconciliationId: string): Promise<ReconcilePaymentResult> {
    const claimedAt = new Date(Date.now());
    const claimed = await this.prisma.client.$transaction((tx) =>
      this.reconcilePaymentRepository.claimDue(tx, reconciliationId, claimedAt),
    );

    if (claimed.result !== CLAIM_RECONCILIATION_RESULT.CLAIMED) {
      return { result: RECONCILE_PAYMENT_RESULT.NOT_CLAIMED };
    }

    const { id, paymentId, leaseToken } = claimed.reconciliation;
    const payment = await this.paymentRepository.findReconciliationPayment(paymentId);

    if (!payment) {
      throw new InternalServerErrorException();
    }

    const gatewayResult = await this.paymentGateway.retrieve({
      paymentKey: payment.paymentKey,
    });

    if (gatewayResult.status === "NOT_PAID") {
      return this.applyNotPaid(id, paymentId, leaseToken);
    }

    if (gatewayResult.status === "UNKNOWN") {
      return this.applyUnknown(id, leaseToken);
    }

    if (gatewayResult.status === "PAID") {
      return this.applyPaid(id, paymentId, leaseToken, payment, gatewayResult);
    }

    throw new InternalServerErrorException();
  }

  private async applyNotPaid(
    reconciliationId: string,
    paymentId: string,
    leaseToken: string,
  ): Promise<ReconcilePaymentResult> {
    const processedAt = new Date(Date.now());

    await this.prisma.client.$transaction(async (tx) => {
      const failed = await this.paymentRepository.failReconciliationPayment(
        tx,
        paymentId,
        processedAt,
      );

      if (failed.result !== FAIL_RECONCILIATION_PAYMENT_RESULT.FAILED) {
        throw new InternalServerErrorException();
      }

      const completed = await this.reconcilePaymentRepository.completeAsNotPaid(
        tx,
        reconciliationId,
        leaseToken,
        processedAt,
      );

      if (completed.result !== COMPLETE_RECONCILIATION_AS_NOT_PAID_RESULT.COMPLETED) {
        throw new InternalServerErrorException();
      }
    });

    return { result: RECONCILE_PAYMENT_RESULT.NOT_PAID };
  }

  private async applyUnknown(
    reconciliationId: string,
    leaseToken: string,
  ): Promise<ReconcilePaymentResult> {
    const processedAt = new Date(Date.now());

    await this.prisma.client.$transaction(async (tx) => {
      const rescheduled = await this.reconcilePaymentRepository.rescheduleAfterUnknown(
        tx,
        reconciliationId,
        leaseToken,
        processedAt,
      );

      if (rescheduled.result !== RESCHEDULE_RECONCILIATION_AFTER_UNKNOWN_RESULT.RESCHEDULED) {
        throw new InternalServerErrorException();
      }
    });

    return { result: RECONCILE_PAYMENT_RESULT.UNKNOWN };
  }

  private async applyPaid(
    reconciliationId: string,
    paymentId: string,
    leaseToken: string,
    payment: ReconciliationPayment,
    gatewayResult: Extract<PaymentGatewayRetrieveResult, { status: "PAID" }>,
  ): Promise<ReconcilePaymentResult> {
    if (!this.matchesPaidIdentity(payment, gatewayResult)) {
      return this.applyIdentityMismatch(reconciliationId, leaseToken);
    }

    const processedAt = new Date(Date.now());

    const refundId = await this.prisma.client.$transaction(async (tx) => {
      const existingRefund = await this.refundRepository.findByPaymentId(tx, paymentId);

      if (existingRefund) {
        throw new InternalServerErrorException();
      }

      const paid = await this.paymentRepository.payReconciliationPayment(
        tx,
        paymentId,
        processedAt,
      );

      if (paid.result !== PAY_RECONCILIATION_PAYMENT_RESULT.PAID) {
        throw new InternalServerErrorException();
      }

      const refund = await this.refundRepository.createPendingRefund(
        tx,
        paymentId,
        payment.amount,
      );

      const completed = await this.reconcilePaymentRepository.completeAsRefundCreated(
        tx,
        reconciliationId,
        leaseToken,
        processedAt,
      );

      if (completed.result !== COMPLETE_RECONCILIATION_AS_REFUND_CREATED_RESULT.COMPLETED) {
        throw new InternalServerErrorException();
      }

      return refund.id;
    });

    this.startProcessRefund(refundId);

    return { result: RECONCILE_PAYMENT_RESULT.PAID };
  }

  private async applyIdentityMismatch(
    reconciliationId: string,
    leaseToken: string,
  ): Promise<ReconcilePaymentResult> {
    const processedAt = new Date(Date.now());

    await this.prisma.client.$transaction(async (tx) => {
      const marked = await this.reconcilePaymentRepository.markReviewForIdentityMismatch(
        tx,
        reconciliationId,
        leaseToken,
        processedAt,
      );

      if (marked.result !== MARK_RECONCILIATION_REVIEW_FOR_IDENTITY_MISMATCH_RESULT.REVIEWED) {
        throw new InternalServerErrorException();
      }
    });

    return { result: RECONCILE_PAYMENT_RESULT.IDENTITY_MISMATCH };
  }

  private matchesPaidIdentity(
    payment: ReconciliationPayment,
    gatewayResult: Extract<PaymentGatewayRetrieveResult, { status: "PAID" }>,
  ): boolean {
    return (
      gatewayResult.paymentKey === payment.paymentKey &&
      gatewayResult.orderId === payment.orderId &&
      gatewayResult.amount === payment.amount
    );
  }

  private startProcessRefund(refundId: string): void {
    void this.processRefundService.execute(refundId).catch((error: unknown) => {
      const stack = error instanceof Error ? error.stack : String(error);
      this.logger.error(`Failed to process refund ${refundId}`, stack);
    });
  }
}
