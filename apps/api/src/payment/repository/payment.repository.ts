import { Injectable, InternalServerErrorException } from "@nestjs/common";
import { Prisma } from "@movie-booking/database-prisma";
import { PrismaService } from "../../database/prisma.service.js";
import { BOOKING_PENDING_STATUS } from "../../booking/booking.constants.js";
import {
  BEGIN_AUTHORIZATION_RESULT,
  EXPIRE_PAYMENT_RESULT,
  FAIL_PAYMENT_RESULT,
  FAIL_RECONCILIATION_PAYMENT_RESULT,
  PAY_PAYMENT_RESULT,
  PAY_RECONCILIATION_PAYMENT_RESULT,
  PAYMENT_AUTHORIZATION_WINDOW_MS,
  PAYMENT_AUTHORIZING_STATUS,
  PAYMENT_CANCELED_STATUS,
  PAYMENT_EXPIRED_STATUS,
  PAYMENT_FAILED_STATUS,
  PAYMENT_PAID_STATUS,
  PAYMENT_PENDING_STATUS,
  PAYMENT_RECONCILIATION_REQUIRED_STATUS,
  RECONCILE_AUTHORIZING_PAYMENT_RESULT,
} from "../payment.constants.js";

type PaymentTransaction = Prisma.TransactionClient;

export type PaidPayment = {
  id: string;
  bookingId: string;
  status: string;
  amount: number;
  paidAt: Date | null;
};

export type PayAuthorizingPaymentResult =
  | { result: typeof PAY_PAYMENT_RESULT.PAID; payment: PaidPayment }
  | { result: typeof PAY_PAYMENT_RESULT.NOT_FOUND }
  | { result: typeof PAY_PAYMENT_RESULT.NOT_AUTHORIZING };

export type BeginAuthorizationResult =
  | {
      result: typeof BEGIN_AUTHORIZATION_RESULT.AUTHORIZING;
      authorizationExpiresAt: Date;
    }
  | { result: typeof BEGIN_AUTHORIZATION_RESULT.NOT_FOUND }
  | { result: typeof BEGIN_AUTHORIZATION_RESULT.NOT_ELIGIBLE };

export type ExpiredPayment = {
  id: string;
  bookingId: string;
  status: string;
};

export type ExpirePendingPaymentResult =
  | { result: typeof EXPIRE_PAYMENT_RESULT.EXPIRED; payment: ExpiredPayment }
  | { result: typeof EXPIRE_PAYMENT_RESULT.NOT_FOUND }
  | { result: typeof EXPIRE_PAYMENT_RESULT.NOT_EXPIRED };

export type ExpirePendingPaymentPastExpiryResult = {
  count: number;
  bookingId: string | null;
};

export type RecoverAuthorizingPaymentPastDeadlineResult = {
  count: number;
  bookingId: string | null;
  userId: string | null;
};

export type FailedPayment = {
  id: string;
  bookingId: string;
  status: string;
  failedAt: Date | null;
};

export type FailAuthorizingPaymentResult =
  | { result: typeof FAIL_PAYMENT_RESULT.FAILED; payment: FailedPayment }
  | { result: typeof FAIL_PAYMENT_RESULT.NOT_FOUND }
  | { result: typeof FAIL_PAYMENT_RESULT.NOT_AUTHORIZING };

export type FailReconciliationPaymentResult =
  | { result: typeof FAIL_RECONCILIATION_PAYMENT_RESULT.FAILED; payment: FailedPayment }
  | { result: typeof FAIL_RECONCILIATION_PAYMENT_RESULT.NOT_FOUND }
  | { result: typeof FAIL_RECONCILIATION_PAYMENT_RESULT.NOT_RECONCILIATION_REQUIRED };

export type PayReconciliationPaymentResult =
  | { result: typeof PAY_RECONCILIATION_PAYMENT_RESULT.PAID; payment: PaidPayment }
  | { result: typeof PAY_RECONCILIATION_PAYMENT_RESULT.NOT_FOUND }
  | { result: typeof PAY_RECONCILIATION_PAYMENT_RESULT.NOT_RECONCILIATION_REQUIRED };

export type OwnedPayment = {
  bookingId: string;
  orderId: string;
  amount: number;
  paymentKey: string | null;
  status: string;
  bookingStatus: string;
  authorizationExpiresAt: Date | null;
  paidAt: Date | null;
  failedAt: Date | null;
};

export type ReconcileAuthorizingPaymentResult =
  | { result: typeof RECONCILE_AUTHORIZING_PAYMENT_RESULT.RECONCILIATION_REQUIRED }
  | { result: typeof RECONCILE_AUTHORIZING_PAYMENT_RESULT.NOT_FOUND }
  | { result: typeof RECONCILE_AUTHORIZING_PAYMENT_RESULT.NOT_AUTHORIZING };

export type CreatedPendingPayment = {
  id: string;
  orderId: string;
  amount: number;
  status: string;
};

export type ReconciliationPayment = {
  orderId: string;
  amount: number;
  paymentKey: string;
};

@Injectable()
export class PaymentRepository {
  constructor(private readonly prisma: PrismaService) {}

  createPendingPayment(
    tx: PaymentTransaction,
    bookingId: string,
    amount: number,
    orderId: string,
  ): Promise<CreatedPendingPayment> {
    return tx.payment.create({
      data: {
        bookingId,
        orderId,
        status: PAYMENT_PENDING_STATUS,
        amount,
      },
      select: {
        id: true,
        orderId: true,
        amount: true,
        status: true,
      },
    });
  }

  async findReconciliationPayment(
    paymentId: string,
  ): Promise<ReconciliationPayment | null> {
    const payment = await this.prisma.client.payment.findUnique({
      where: { id: paymentId },
      select: {
        orderId: true,
        amount: true,
        paymentKey: true,
      },
    });

    if (!payment) {
      return null;
    }

    if (payment.paymentKey === null) {
      throw new InternalServerErrorException();
    }

    return {
      orderId: payment.orderId,
      amount: payment.amount,
      paymentKey: payment.paymentKey,
    };
  }

  async findOwnedPayment(paymentId: string, userId: string): Promise<OwnedPayment | null> {
    const payment = await this.prisma.client.payment.findFirst({
      where: {
        id: paymentId,
        booking: { userId },
      },
      select: {
        bookingId: true,
        orderId: true,
        amount: true,
        paymentKey: true,
        status: true,
        authorizationExpiresAt: true,
        paidAt: true,
        failedAt: true,
        booking: { select: { status: true } },
      },
    });

    if (!payment) {
      return null;
    }

    return {
      bookingId: payment.bookingId,
      orderId: payment.orderId,
      amount: payment.amount,
      paymentKey: payment.paymentKey,
      status: payment.status,
      bookingStatus: payment.booking.status,
      authorizationExpiresAt: payment.authorizationExpiresAt,
      paidAt: payment.paidAt,
      failedAt: payment.failedAt,
    };
  }

  async beginAuthorization(
    tx: PaymentTransaction,
    paymentId: string,
    userId: string,
    paymentKey: string,
    now: Date,
  ): Promise<BeginAuthorizationResult> {
    const authorizationExpiresAt = new Date(now.getTime() + PAYMENT_AUTHORIZATION_WINDOW_MS);
    const authorizing = await tx.payment.updateMany({
      where: {
        id: paymentId,
        status: PAYMENT_PENDING_STATUS,
        booking: {
          userId,
          status: BOOKING_PENDING_STATUS,
          expiresAt: { gt: now },
        },
      },
      data: {
        status: PAYMENT_AUTHORIZING_STATUS,
        authorizationExpiresAt,
        paymentKey,
      },
    });

    if (authorizing.count === 1) {
      return {
        result: BEGIN_AUTHORIZATION_RESULT.AUTHORIZING,
        authorizationExpiresAt,
      };
    }

    const payment = await tx.payment.findFirst({
      where: {
        id: paymentId,
        booking: { userId },
      },
      select: { id: true },
    });

    if (!payment) {
      return { result: BEGIN_AUTHORIZATION_RESULT.NOT_FOUND };
    }

    return { result: BEGIN_AUTHORIZATION_RESULT.NOT_ELIGIBLE };
  }

  async expirePendingPayment(
    tx: PaymentTransaction,
    paymentId: string,
    userId: string,
    now: Date,
  ): Promise<ExpirePendingPaymentResult> {
    const expired = await tx.payment.updateMany({
      where: {
        id: paymentId,
        status: PAYMENT_PENDING_STATUS,
        booking: {
          userId,
          status: BOOKING_PENDING_STATUS,
          expiresAt: { lte: now },
        },
      },
      data: {
        status: PAYMENT_EXPIRED_STATUS,
      },
    });

    if (expired.count !== 1) {
      const payment = await tx.payment.findFirst({
        where: {
          id: paymentId,
          booking: { userId },
        },
        select: { id: true },
      });

      if (!payment) {
        return { result: EXPIRE_PAYMENT_RESULT.NOT_FOUND };
      }

      return { result: EXPIRE_PAYMENT_RESULT.NOT_EXPIRED };
    }

    const payment = await tx.payment.findUniqueOrThrow({
      where: { id: paymentId },
      select: {
        id: true,
        bookingId: true,
        status: true,
      },
    });

    return {
      result: EXPIRE_PAYMENT_RESULT.EXPIRED,
      payment,
    };
  }

  async expirePendingPaymentPastExpiry(
    tx: PaymentTransaction,
    paymentId: string,
    now: Date,
  ): Promise<ExpirePendingPaymentPastExpiryResult> {
    const expired = await tx.payment.updateMany({
      where: {
        id: paymentId,
        status: PAYMENT_PENDING_STATUS,
        booking: {
          status: BOOKING_PENDING_STATUS,
          expiresAt: { lte: now },
        },
      },
      data: {
        status: PAYMENT_EXPIRED_STATUS,
      },
    });

    if (expired.count !== 1) {
      return { count: expired.count, bookingId: null };
    }

    const payment = await tx.payment.findUniqueOrThrow({
      where: { id: paymentId },
      select: { bookingId: true },
    });

    return { count: 1, bookingId: payment.bookingId };
  }

  async findExpiredPendingPaymentIds(now: Date, limit: number): Promise<string[]> {
    const payments = await this.prisma.client.payment.findMany({
      where: {
        status: PAYMENT_PENDING_STATUS,
        booking: {
          status: BOOKING_PENDING_STATUS,
          expiresAt: { lte: now },
        },
      },
      orderBy: { booking: { expiresAt: "asc" } },
      take: limit,
      select: { id: true },
    });

    return payments.map((payment) => payment.id);
  }

  async findAuthorizingPaymentIdsPastDeadline(now: Date, limit: number): Promise<string[]> {
    const payments = await this.prisma.client.payment.findMany({
      where: {
        status: PAYMENT_AUTHORIZING_STATUS,
        authorizationExpiresAt: { lte: now },
        booking: { status: BOOKING_PENDING_STATUS },
      },
      orderBy: { authorizationExpiresAt: "asc" },
      take: limit,
      select: { id: true },
    });

    return payments.map((payment) => payment.id);
  }

  async recoverAuthorizingPaymentPastDeadline(
    tx: PaymentTransaction,
    paymentId: string,
    now: Date,
  ): Promise<RecoverAuthorizingPaymentPastDeadlineResult> {
    const recovered = await tx.payment.updateMany({
      where: {
        id: paymentId,
        status: PAYMENT_AUTHORIZING_STATUS,
        authorizationExpiresAt: { lte: now },
        booking: { status: BOOKING_PENDING_STATUS },
      },
      data: {
        status: PAYMENT_RECONCILIATION_REQUIRED_STATUS,
      },
    });

    if (recovered.count !== 1) {
      return { count: recovered.count, bookingId: null, userId: null };
    }

    const payment = await tx.payment.findUniqueOrThrow({
      where: { id: paymentId },
      select: {
        bookingId: true,
        booking: { select: { userId: true } },
      },
    });

    return { count: 1, bookingId: payment.bookingId, userId: payment.booking.userId };
  }

  async reconcileAuthorizingPayment(
    tx: PaymentTransaction,
    paymentId: string,
    userId: string,
    now: Date,
  ): Promise<ReconcileAuthorizingPaymentResult> {
    const reconciled = await tx.payment.updateMany({
      where: {
        id: paymentId,
        status: PAYMENT_AUTHORIZING_STATUS,
        authorizationExpiresAt: { lte: now },
        booking: {
          userId,
          status: BOOKING_PENDING_STATUS,
        },
      },
      data: {
        status: PAYMENT_RECONCILIATION_REQUIRED_STATUS,
      },
    });

    if (reconciled.count === 1) {
      return { result: RECONCILE_AUTHORIZING_PAYMENT_RESULT.RECONCILIATION_REQUIRED };
    }

    const payment = await tx.payment.findFirst({
      where: {
        id: paymentId,
        booking: { userId },
      },
      select: { id: true },
    });

    if (!payment) {
      return { result: RECONCILE_AUTHORIZING_PAYMENT_RESULT.NOT_FOUND };
    }

    return { result: RECONCILE_AUTHORIZING_PAYMENT_RESULT.NOT_AUTHORIZING };
  }

  async payAuthorizingPayment(
    tx: PaymentTransaction,
    paymentId: string,
    userId: string,
    paymentKey: string,
    now: Date,
  ): Promise<PayAuthorizingPaymentResult> {
    const paid = await tx.payment.updateMany({
      where: {
        id: paymentId,
        status: PAYMENT_AUTHORIZING_STATUS,
        authorizationExpiresAt: { gt: now },
        booking: {
          userId,
          status: BOOKING_PENDING_STATUS,
        },
      },
      data: {
        status: PAYMENT_PAID_STATUS,
        paymentKey,
        paidAt: now,
      },
    });

    if (paid.count !== 1) {
      const payment = await tx.payment.findFirst({
        where: {
          id: paymentId,
          booking: { userId },
        },
        select: { id: true },
      });

      if (!payment) {
        return { result: PAY_PAYMENT_RESULT.NOT_FOUND };
      }

      return { result: PAY_PAYMENT_RESULT.NOT_AUTHORIZING };
    }

    const payment = await tx.payment.findUniqueOrThrow({
      where: { id: paymentId },
      select: {
        id: true,
        bookingId: true,
        status: true,
        amount: true,
        paidAt: true,
      },
    });

    return {
      result: PAY_PAYMENT_RESULT.PAID,
      payment,
    };
  }

  async failAuthorizingPayment(
    tx: PaymentTransaction,
    paymentId: string,
    userId: string,
  ): Promise<FailAuthorizingPaymentResult> {
    const failedAt = new Date();
    const closed = await tx.payment.updateMany({
      where: {
        id: paymentId,
        status: PAYMENT_AUTHORIZING_STATUS,
        booking: {
          userId,
          status: BOOKING_PENDING_STATUS,
        },
      },
      data: {
        status: PAYMENT_FAILED_STATUS,
        failedAt,
      },
    });

    if (closed.count !== 1) {
      const payment = await tx.payment.findFirst({
        where: {
          id: paymentId,
          booking: { userId },
        },
        select: { id: true },
      });

      if (!payment) {
        return { result: FAIL_PAYMENT_RESULT.NOT_FOUND };
      }

      return { result: FAIL_PAYMENT_RESULT.NOT_AUTHORIZING };
    }

    const payment = await tx.payment.findUniqueOrThrow({
      where: { id: paymentId },
      select: {
        id: true,
        bookingId: true,
        status: true,
        failedAt: true,
      },
    });

    return {
      result: FAIL_PAYMENT_RESULT.FAILED,
      payment: {
        id: payment.id,
        bookingId: payment.bookingId,
        status: payment.status,
        failedAt: payment.failedAt,
      },
    };
  }

  async failReconciliationPayment(
    tx: PaymentTransaction,
    paymentId: string,
    failedAt: Date,
  ): Promise<FailReconciliationPaymentResult> {
    const closed = await tx.payment.updateMany({
      where: {
        id: paymentId,
        status: PAYMENT_RECONCILIATION_REQUIRED_STATUS,
      },
      data: {
        status: PAYMENT_FAILED_STATUS,
        failedAt,
      },
    });

    if (closed.count !== 1) {
      const payment = await tx.payment.findUnique({
        where: { id: paymentId },
        select: { id: true },
      });

      if (!payment) {
        return { result: FAIL_RECONCILIATION_PAYMENT_RESULT.NOT_FOUND };
      }

      return { result: FAIL_RECONCILIATION_PAYMENT_RESULT.NOT_RECONCILIATION_REQUIRED };
    }

    const payment = await tx.payment.findUniqueOrThrow({
      where: { id: paymentId },
      select: {
        id: true,
        bookingId: true,
        status: true,
        failedAt: true,
      },
    });

    return {
      result: FAIL_RECONCILIATION_PAYMENT_RESULT.FAILED,
      payment: {
        id: payment.id,
        bookingId: payment.bookingId,
        status: payment.status,
        failedAt: payment.failedAt,
      },
    };
  }

  async payReconciliationPayment(
    tx: PaymentTransaction,
    paymentId: string,
    paidAt: Date,
  ): Promise<PayReconciliationPaymentResult> {
    const paid = await tx.payment.updateMany({
      where: {
        id: paymentId,
        status: PAYMENT_RECONCILIATION_REQUIRED_STATUS,
      },
      data: {
        status: PAYMENT_PAID_STATUS,
        paidAt,
      },
    });

    if (paid.count !== 1) {
      const payment = await tx.payment.findUnique({
        where: { id: paymentId },
        select: { id: true },
      });

      if (!payment) {
        return { result: PAY_RECONCILIATION_PAYMENT_RESULT.NOT_FOUND };
      }

      return { result: PAY_RECONCILIATION_PAYMENT_RESULT.NOT_RECONCILIATION_REQUIRED };
    }

    const payment = await tx.payment.findUniqueOrThrow({
      where: { id: paymentId },
      select: {
        id: true,
        bookingId: true,
        status: true,
        amount: true,
        paidAt: true,
      },
    });

    return {
      result: PAY_RECONCILIATION_PAYMENT_RESULT.PAID,
      payment,
    };
  }
}

export function cancelPendingPayment(
  tx: PaymentTransaction,
  paymentId: string,
  bookingId: string,
  userId: string,
  now: Date,
) {
  return tx.payment.updateMany({
    where: {
      id: paymentId,
      status: PAYMENT_PENDING_STATUS,
      booking: {
        id: bookingId,
        userId,
        status: BOOKING_PENDING_STATUS,
        expiresAt: { gt: now },
      },
    },
    data: {
      status: PAYMENT_CANCELED_STATUS,
    },
  });
}
