import { ConflictException, Injectable, InternalServerErrorException, NotFoundException } from "@nestjs/common";
import type { AuthenticatedUser } from "../../auth/decorators/current-user.decorator.js";
import { BOOKING_PENDING_STATUS } from "../../booking/booking.constants.js";
import { BookingRepository } from "../../booking/repository/booking.repository.js";
import { BookingSeatReleaseService } from "../../booking/use-case/booking-seat-release.service.js";
import { PrismaService } from "../../database/prisma.service.js";
import { ReconciliationRequiredPaymentResponseDto } from "../dto/reconciliation-required-payment-response.dto.js";
import { FailedPaymentResponseDto } from "../dto/failed-payment-response.dto.js";
import { PaymentResponseDto } from "../dto/payment-response.dto.js";
import {
  PaymentGateway,
  type PaymentGatewayConfirmResult,
  type PaymentGatewayRetrieveResult,
} from "../gateway/payment-gateway.js";
import {
  BEGIN_AUTHORIZATION_RESULT,
  EXPIRE_PAYMENT_RESULT,
  FAIL_PAYMENT_RESULT,
  PAY_PAYMENT_RESULT,
  PAYMENT_AUTHORIZING_RETRIEVE_INTERVAL_MS,
  PAYMENT_EXPIRED_STATUS,
  PAYMENT_PENDING_STATUS,
  PAYMENT_RECONCILIATION_REQUIRED_STATUS,
  RECONCILE_AUTHORIZING_PAYMENT_RESULT,
} from "../payment.constants.js";
import { PaymentRepository, type OwnedPayment } from "../repository/payment.repository.js";
import { ReconcilePaymentRepository } from "../repository/reconcile-payment.repository.js";
import type { Prisma } from "@movie-booking/database-prisma";

type PaymentTransaction = Prisma.TransactionClient;
type PayPreparation =
  | { outcome: "AUTHORIZING"; authorizationExpiresAt: Date }
  | { outcome: "EXPIRED" }
  | { outcome: "NOT_FOUND" }
  | { outcome: "CONFLICT" };
type GatewayOutcome =
  | { status: "SUCCESS"; paymentKey: string; observedAt: Date }
  | { status: "FAILED"; observedAt: Date }
  | { status: "RECONCILE"; observedAt: Date };

const PAYMENT_NOT_PAYABLE_MESSAGE = "결제할 수 없는 상태입니다.";
const PAYMENT_EXPIRED_MESSAGE = "결제 가능 시간이 만료되었습니다.";

@Injectable()
export class PaymentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly paymentRepository: PaymentRepository,
    private readonly paymentGateway: PaymentGateway,
    private readonly bookingRepository: BookingRepository,
    private readonly bookingSeatReleaseService: BookingSeatReleaseService,
    private readonly reconcilePaymentRepository: ReconcilePaymentRepository,
  ) {}

  async pay(
    user: AuthenticatedUser,
    paymentId: string,
    paymentKey: string,
  ): Promise<PaymentResponseDto | FailedPaymentResponseDto | ReconciliationRequiredPaymentResponseDto> {
    // 결제 정보 조회
    const payment = await this.paymentRepository.findOwnedPayment(paymentId, user.id);

    // 결제 정보 조회 결과 처리
    if (!payment) {
      throw new NotFoundException("결제를 찾을 수 없습니다.");
    }

    if (payment.status === PAYMENT_EXPIRED_STATUS) {
      throw new ConflictException(PAYMENT_EXPIRED_MESSAGE);
    }

    if (payment.status !== PAYMENT_PENDING_STATUS || payment.bookingStatus !== BOOKING_PENDING_STATUS) {
      throw new ConflictException(PAYMENT_NOT_PAYABLE_MESSAGE);
    }

    // 결제 정보 검증
    const prepared = await this.prisma.client.$transaction((tx) =>
      this.authorizeOrExpire(tx, user.id, paymentId, paymentKey),
    );

    // 결제 정보 검증 결과 처리
    if (prepared.outcome === "NOT_FOUND") {
      throw new NotFoundException("결제를 찾을 수 없습니다.");
    }

    if (prepared.outcome === "EXPIRED") {
      throw new ConflictException(PAYMENT_EXPIRED_MESSAGE);
    }

    if (prepared.outcome === "CONFLICT") {
      throw new ConflictException(PAYMENT_NOT_PAYABLE_MESSAGE);
    }

    // 결제 결과 조회
    const outcome = await this.resolveGatewayOutcome(payment, paymentKey, prepared.authorizationExpiresAt);

    if (outcome.status === "SUCCESS") {
      return this.markPaid(user, paymentId, outcome.paymentKey, outcome.observedAt);
    }

    if (outcome.status === "FAILED") {
      return this.markFailed(user, paymentId);
    }

    return this.markReconciliationRequired(user, paymentId, payment.bookingId, outcome.observedAt);
  }

  private async resolveGatewayOutcome(
    payment: OwnedPayment,
    paymentKey: string,
    authorizationExpiresAt: Date,
  ): Promise<GatewayOutcome> {
    let result: PaymentGatewayConfirmResult | PaymentGatewayRetrieveResult =
      await this.paymentGateway.confirm({
        paymentKey,
        orderId: payment.orderId,
        amount: payment.amount,
      });

    for (;;) {
      const observed = this.appliedOutcome(payment, result, paymentKey, authorizationExpiresAt);
      if (observed) {
        return observed;
      }

      result = await this.paymentGateway.retrieve({ paymentKey });
      const retrieved = this.appliedOutcome(payment, result, paymentKey, authorizationExpiresAt);
      if (retrieved) {
        return retrieved;
      }

      await waitForNextRetrieve(authorizationExpiresAt);
    }
  }

  private appliedOutcome(
    payment: OwnedPayment,
    result: PaymentGatewayConfirmResult | PaymentGatewayRetrieveResult,
    paymentKey: string,
    authorizationExpiresAt: Date,
  ): GatewayOutcome | null {
    const observedAt = new Date(Date.now());
    const withinDeadline = observedAt.getTime() < authorizationExpiresAt.getTime();
    const paid =
      result.status === "SUCCESS" || result.status === "PAID"
        ? result
        : null;

    if (
      paid &&
      paid.orderId === payment.orderId &&
      paid.amount === payment.amount &&
      paid.paymentKey === paymentKey
    ) {
      if (!withinDeadline) {
        return { status: "RECONCILE", observedAt };
      }

      return { status: "SUCCESS", paymentKey: paid.paymentKey, observedAt };
    }

    if (result.status === "FAILED" || result.status === "NOT_PAID") {
      return { status: "FAILED", observedAt };
    }

    if (!withinDeadline) {
      return { status: "RECONCILE", observedAt };
    }

    return null;
  }

  private async authorizeOrExpire(
    tx: PaymentTransaction,
    userId: string,
    paymentId: string,
    paymentKey: string,
  ): Promise<PayPreparation> {
    const now = new Date(Date.now());

    const authorizing = await this.paymentRepository.beginAuthorization(tx, paymentId, userId, paymentKey, now);

    if (authorizing.result === BEGIN_AUTHORIZATION_RESULT.AUTHORIZING) {
      return {
        outcome: "AUTHORIZING",
        authorizationExpiresAt: authorizing.authorizationExpiresAt,
      };
    }

    if (authorizing.result === BEGIN_AUTHORIZATION_RESULT.NOT_FOUND) {
      return { outcome: "NOT_FOUND" };
    }

    const expired = await this.paymentRepository.expirePendingPayment(tx, paymentId, userId, now);

    if (expired.result === EXPIRE_PAYMENT_RESULT.NOT_FOUND) {
      return { outcome: "NOT_FOUND" };
    }

    if (expired.result === EXPIRE_PAYMENT_RESULT.NOT_EXPIRED) {
      return { outcome: "CONFLICT" };
    }

    const bookingExpired = await this.bookingRepository.expirePendingBooking(
      tx,
      expired.payment.bookingId,
      userId,
      now,
    );

    if (bookingExpired.count !== 1) {
      throw new InternalServerErrorException();
    }

    await this.bookingSeatReleaseService.release(tx, expired.payment.bookingId);

    return { outcome: "EXPIRED" };
  }

  private async markPaid(
    user: AuthenticatedUser,
    paymentId: string,
    paymentKey: string,
    observedAt: Date,
  ): Promise<PaymentResponseDto> {
    const applied = await this.prisma.client.$transaction(async (tx) => {
      const payResult = await this.paymentRepository.payAuthorizingPayment(
        tx,
        paymentId,
        user.id,
        paymentKey,
        observedAt,
      );

      if (payResult.result !== PAY_PAYMENT_RESULT.PAID) {
        return payResult;
      }

      if (!payResult.payment.paidAt) {
        throw new InternalServerErrorException();
      }

      const confirmed = await this.bookingRepository.confirmPendingBooking(
        tx,
        payResult.payment.bookingId,
        user.id,
        payResult.payment.paidAt,
      );

      if (confirmed.count !== 1) {
        throw new InternalServerErrorException();
      }

      return payResult;
    });

    if (applied.result === PAY_PAYMENT_RESULT.PAID && applied.payment.paidAt) {
      return {
        id: applied.payment.id,
        bookingId: applied.payment.bookingId,
        status: applied.payment.status,
        paidAt: applied.payment.paidAt.toISOString(),
      };
    }

    if (applied.result === PAY_PAYMENT_RESULT.NOT_FOUND) {
      throw new NotFoundException("결제를 찾을 수 없습니다.");
    }

    throw new ConflictException(PAYMENT_NOT_PAYABLE_MESSAGE);
  }

  private async markFailed(user: AuthenticatedUser, paymentId: string): Promise<FailedPaymentResponseDto> {
    const applied = await this.prisma.client.$transaction(async (tx) => {
      const closeResult = await this.paymentRepository.failAuthorizingPayment(tx, paymentId, user.id);

      if (closeResult.result !== FAIL_PAYMENT_RESULT.FAILED) {
        return closeResult;
      }

      if (!closeResult.payment.failedAt) {
        throw new InternalServerErrorException();
      }

      const failed = await this.bookingRepository.failPendingBooking(
        tx,
        closeResult.payment.bookingId,
        user.id,
        closeResult.payment.failedAt,
      );

      if (failed.count !== 1) {
        throw new InternalServerErrorException();
      }

      await this.bookingSeatReleaseService.release(tx, closeResult.payment.bookingId);

      return closeResult;
    });

    if (applied.result === FAIL_PAYMENT_RESULT.FAILED && applied.payment.failedAt) {
      return {
        id: applied.payment.id,
        bookingId: applied.payment.bookingId,
        status: applied.payment.status,
        failedAt: applied.payment.failedAt.toISOString(),
      };
    }

    if (applied.result === FAIL_PAYMENT_RESULT.NOT_FOUND) {
      throw new NotFoundException("결제를 찾을 수 없습니다.");
    }

    throw new ConflictException(PAYMENT_NOT_PAYABLE_MESSAGE);
  }

  private async markReconciliationRequired(
    user: AuthenticatedUser,
    paymentId: string,
    bookingId: string,
    observedAt: Date,
  ): Promise<ReconciliationRequiredPaymentResponseDto> {
    const applied = await this.prisma.client.$transaction(async (tx) => {
      const reconciled = await this.paymentRepository.reconcileAuthorizingPayment(tx, paymentId, user.id, observedAt);

      if (reconciled.result !== RECONCILE_AUTHORIZING_PAYMENT_RESULT.RECONCILIATION_REQUIRED) {
        return reconciled.result;
      }

      const cancelled = await this.bookingRepository.cancelPendingBookingForReconciliation(
        tx,
        bookingId,
        user.id,
        observedAt,
      );

      if (cancelled.count !== 1) {
        throw new InternalServerErrorException();
      }

      await this.bookingSeatReleaseService.release(tx, bookingId);
      await this.reconcilePaymentRepository.createOpen(tx, paymentId, observedAt);

      return reconciled.result;
    });

    if (applied === RECONCILE_AUTHORIZING_PAYMENT_RESULT.NOT_FOUND) {
      throw new NotFoundException("결제를 찾을 수 없습니다.");
    }

    if (applied === RECONCILE_AUTHORIZING_PAYMENT_RESULT.NOT_AUTHORIZING) {
      throw new ConflictException(PAYMENT_NOT_PAYABLE_MESSAGE);
    }

    return {
      id: paymentId,
      bookingId,
      status: PAYMENT_RECONCILIATION_REQUIRED_STATUS,
    };
  }
}

function waitForNextRetrieve(authorizationExpiresAt: Date): Promise<void> {
  const remaining = authorizationExpiresAt.getTime() - Date.now();
  if (remaining <= 0) {
    return Promise.resolve();
  }

  const delay = Math.min(PAYMENT_AUTHORIZING_RETRIEVE_INTERVAL_MS, remaining);
  return new Promise((resolve) => {
    setTimeout(resolve, delay);
  });
}
