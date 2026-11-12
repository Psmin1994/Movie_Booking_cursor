/**
 * Test Intent:
 * Gateway confirm이 authorizationExpiresAt 이전 SUCCESS로 관측된 뒤 markPaid의 payAuthorizingPayment가
 * 실행되기 전에 RecoverAuthorizingPaymentService가 먼저 Commit하면, pay()는 Booking을 CONFIRMED로
 * 확정하지 못하고 Conflict로 끝나며 Recovery가 남긴 RECONCILIATION_REQUIRED / CANCELLED / AVAILABLE /
 * SCHEDULED Reconciliation 상태가 유지되고 Reconciliation은 중복 생성되지 않는다.
 */

import { randomInt, randomUUID } from "node:crypto";
import { jest } from "@jest/globals";
import { ConflictException, INestApplication } from "@nestjs/common";
import { App } from "supertest/types";
import {
  BOOKING_CANCELLED_STATUS,
  BOOKING_CONFIRMED_STATUS,
  BOOKING_PENDING_STATUS,
  SCREENING_SEAT_AVAILABLE_STATUS,
  SCREENING_SEAT_BOOKED_STATUS,
} from "../src/booking/booking.constants.js";
import { ExpireBookingScheduler } from "../src/booking/scheduler/expire-booking.scheduler.js";
import { PrismaService } from "../src/database/prisma.service.js";
import {
  PaymentGateway,
  type PaymentGatewayCancelInput,
  type PaymentGatewayCancelResult,
  type PaymentGatewayConfirmInput,
  type PaymentGatewayConfirmResult,
  type PaymentGatewayRetrieveCancelOutcomeInput,
  type PaymentGatewayRetrieveCancelOutcomeResult,
  type PaymentGatewayRetrieveInput,
  type PaymentGatewayRetrieveResult,
} from "../src/payment/gateway/payment-gateway.js";
import {
  PAYMENT_AUTHORIZING_STATUS,
  PAYMENT_PAID_STATUS,
  PAYMENT_PENDING_STATUS,
  PAYMENT_RECONCILIATION_REQUIRED_STATUS,
  RECONCILIATION_SCHEDULED_STATUS,
  RECOVER_AUTHORIZING_PAYMENT_RESULT,
} from "../src/payment/payment.constants.js";
import { PaymentRepository } from "../src/payment/repository/payment.repository.js";
import { ExpirePaymentScheduler } from "../src/payment/scheduler/expire-payment.scheduler.js";
import { ReconcilePaymentScheduler } from "../src/payment/scheduler/reconcile-payment.scheduler.js";
import { RecoverAuthorizingPaymentScheduler } from "../src/payment/scheduler/recover-authorizing-payment.scheduler.js";
import { PaymentService } from "../src/payment/use-case/payment.service.js";
import { RecoverAuthorizingPaymentService } from "../src/payment/use-case/recover-authorizing-payment.service.js";
import { ProcessRefundScheduler } from "../src/refund/scheduler/process-refund.scheduler.js";
import { createTestApp } from "./helpers/create-test-app.js";

jest.setTimeout(30_000);

const AMOUNT = 11_000;

const idleScheduler = {
  async expireDueBookings(): Promise<void> {
    return undefined;
  },
  async expireDuePayments(): Promise<void> {
    return undefined;
  },
  async recoverDueAuthorizingPayments(): Promise<void> {
    return undefined;
  },
  async processDueReconciliations(): Promise<void> {
    return undefined;
  },
  async processDueRefunds(): Promise<void> {
    return undefined;
  },
};

type Fixture = {
  userId: string;
  movieId: string;
  screenId: string;
  screeningId: string;
  screeningSeatId: string;
  bookingId: string;
  paymentId: string;
  orderId: string;
  amount: number;
};

class ScriptableConfirmGateway extends PaymentGateway {
  confirmImpl: (
    input: PaymentGatewayConfirmInput,
  ) => Promise<PaymentGatewayConfirmResult> = async () => ({ status: "UNKNOWN" });

  confirm(input: PaymentGatewayConfirmInput): Promise<PaymentGatewayConfirmResult> {
    return this.confirmImpl(input);
  }

  retrieve(_input: PaymentGatewayRetrieveInput): Promise<PaymentGatewayRetrieveResult> {
    return Promise.resolve({ status: "UNKNOWN" });
  }

  cancel(_input: PaymentGatewayCancelInput): Promise<PaymentGatewayCancelResult> {
    return Promise.resolve({ status: "UNKNOWN" });
  }

  retrieveCancelOutcome(
    _input: PaymentGatewayRetrieveCancelOutcomeInput,
  ): Promise<PaymentGatewayRetrieveCancelOutcomeResult> {
    return Promise.resolve({ status: "UNKNOWN" });
  }
}

describe("Payment SUCCESS then Recovery before markPaid on PostgreSQL", () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let paymentService: PaymentService;
  let paymentRepository: PaymentRepository;
  let recoverAuthorizingPaymentService: RecoverAuthorizingPaymentService;
  const paymentGateway = new ScriptableConfirmGateway();

  beforeAll(async () => {
    app = await createTestApp((builder) =>
      builder
        .overrideProvider(PaymentGateway)
        .useValue(paymentGateway)
        .overrideProvider(ExpireBookingScheduler)
        .useValue(idleScheduler)
        .overrideProvider(ExpirePaymentScheduler)
        .useValue(idleScheduler)
        .overrideProvider(RecoverAuthorizingPaymentScheduler)
        .useValue(idleScheduler)
        .overrideProvider(ReconcilePaymentScheduler)
        .useValue(idleScheduler)
        .overrideProvider(ProcessRefundScheduler)
        .useValue(idleScheduler),
    );
    prisma = app.get(PrismaService);
    paymentService = app.get(PaymentService);
    paymentRepository = app.get(PaymentRepository);
    recoverAuthorizingPaymentService = app.get(RecoverAuthorizingPaymentService);
  });

  afterAll(async () => {
    await app.close();
  });

  it("keeps recovery state when Gateway SUCCESS is observed before markPaid loses to recovery", async () => {
    const fixture = await createFixture(prisma);
    const paymentKey = `pay_${randomUUID()}`;
    let authorizationExpiresAtAtConfirm: Date | null = null;
    let observedSuccessAt: Date | null = null;
    let recoveryCommittedBeforePayUpdate = false;

    paymentGateway.confirmImpl = async (input) => {
      const payment = await prisma.client.payment.findUniqueOrThrow({
        where: { id: fixture.paymentId },
        select: { status: true, authorizationExpiresAt: true, orderId: true, amount: true },
      });
      expect(payment.status).toBe(PAYMENT_AUTHORIZING_STATUS);
      expect(payment.authorizationExpiresAt).not.toBeNull();
      authorizationExpiresAtAtConfirm = payment.authorizationExpiresAt;
      observedSuccessAt = new Date(Date.now());
      expect(observedSuccessAt.getTime()).toBeLessThan(authorizationExpiresAtAtConfirm!.getTime());

      return {
        status: "SUCCESS",
        paymentKey: input.paymentKey,
        orderId: payment.orderId,
        amount: payment.amount,
        approvedAt: observedSuccessAt,
      };
    };

    const originalPayAuthorizing = paymentRepository.payAuthorizingPayment.bind(paymentRepository);
    const payAuthorizingSpy = jest
      .spyOn(paymentRepository, "payAuthorizingPayment")
      .mockImplementation(async (tx, paymentId, userId, key, observedAt) => {
        expect(observedAt.getTime()).toBeLessThan(authorizationExpiresAtAtConfirm!.getTime());
        expect(observedSuccessAt).not.toBeNull();
        expect(observedAt.getTime()).toBeGreaterThanOrEqual(observedSuccessAt!.getTime());

        await prisma.client.payment.update({
          where: { id: paymentId },
          data: {
            authorizationExpiresAt: new Date(Date.now() - 1_000),
          },
        });

        await expect(recoverAuthorizingPaymentService.execute(paymentId)).resolves.toEqual({
          result: RECOVER_AUTHORIZING_PAYMENT_RESULT.RECONCILIATION_REQUIRED,
        });
        recoveryCommittedBeforePayUpdate = true;

        const afterRecovery = await readState(prisma, fixture);
        expect(afterRecovery).toEqual({
          paymentStatus: PAYMENT_RECONCILIATION_REQUIRED_STATUS,
          bookingStatus: BOOKING_CANCELLED_STATUS,
          seatStatus: SCREENING_SEAT_AVAILABLE_STATUS,
          reconciliationStatus: RECONCILIATION_SCHEDULED_STATUS,
          reconciliationCount: 1,
        });

        return originalPayAuthorizing(tx, paymentId, userId, key, observedAt);
      });

    try {
      await expect(
        paymentService.pay({ id: fixture.userId }, fixture.paymentId, paymentKey),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(recoveryCommittedBeforePayUpdate).toBe(true);
      expect(payAuthorizingSpy).toHaveBeenCalledTimes(1);
      expect(paymentGateway.confirmImpl).toBeDefined();

      const finalState = await readState(prisma, fixture);
      expect(finalState).toEqual({
        paymentStatus: PAYMENT_RECONCILIATION_REQUIRED_STATUS,
        bookingStatus: BOOKING_CANCELLED_STATUS,
        seatStatus: SCREENING_SEAT_AVAILABLE_STATUS,
        reconciliationStatus: RECONCILIATION_SCHEDULED_STATUS,
        reconciliationCount: 1,
      });

      const payment = await prisma.client.payment.findUniqueOrThrow({
        where: { id: fixture.paymentId },
        select: { status: true, paidAt: true },
      });
      const booking = await prisma.client.booking.findUniqueOrThrow({
        where: { id: fixture.bookingId },
        select: { status: true, confirmedAt: true },
      });
      expect(payment.status).not.toBe(PAYMENT_PAID_STATUS);
      expect(payment.paidAt).toBeNull();
      expect(booking.status).not.toBe(BOOKING_CONFIRMED_STATUS);
      expect(booking.confirmedAt).toBeNull();
    } finally {
      payAuthorizingSpy.mockRestore();
      await deleteFixture(prisma, fixture);
    }
  });
});

async function createFixture(prisma: PrismaService): Promise<Fixture> {
  const suffix = randomUUID();
  const orderId = `ord_${suffix}`;
  const user = await prisma.client.user.create({
    data: {
      email: `payment-success-recovery-race-${suffix}@example.com`,
      passwordHash: "test-hash",
      name: "Payment Success Recovery Race",
    },
  });
  const movie = await prisma.client.movie.create({
    data: {
      title: `payment-success-recovery-race-${suffix}`,
      runtime: 100,
      releaseDate: new Date("2026-01-01"),
    },
  });
  const screen = await prisma.client.screen.create({
    data: {
      number: randomInt(1_000_000, 2_000_000_000),
      floor: 1,
      screenType: "TEST",
    },
  });
  const screening = await prisma.client.screening.create({
    data: {
      movieId: movie.id,
      screenId: screen.id,
      startAt: new Date("2099-01-01T00:00:00.000Z"),
    },
  });
  const seat = await prisma.client.seat.create({
    data: {
      screenId: screen.id,
      row: "R",
      number: 1,
      seatType: "STANDARD",
    },
  });
  const screeningSeat = await prisma.client.screeningSeat.create({
    data: {
      screeningId: screening.id,
      seatId: seat.id,
      status: SCREENING_SEAT_BOOKED_STATUS,
    },
  });
  const booking = await prisma.client.booking.create({
    data: {
      userId: user.id,
      screeningId: screening.id,
      status: BOOKING_PENDING_STATUS,
      totalAmount: AMOUNT,
      expiresAt: new Date(Date.now() + 10 * 60_000),
    },
  });
  await prisma.client.bookingSeat.create({
    data: {
      bookingId: booking.id,
      screeningSeatId: screeningSeat.id,
    },
  });
  const payment = await prisma.client.payment.create({
    data: {
      bookingId: booking.id,
      orderId,
      status: PAYMENT_PENDING_STATUS,
      amount: AMOUNT,
    },
  });

  return {
    userId: user.id,
    movieId: movie.id,
    screenId: screen.id,
    screeningId: screening.id,
    screeningSeatId: screeningSeat.id,
    bookingId: booking.id,
    paymentId: payment.id,
    orderId,
    amount: AMOUNT,
  };
}

async function readState(prisma: PrismaService, fixture: Fixture) {
  const payment = await prisma.client.payment.findUniqueOrThrow({
    where: { id: fixture.paymentId },
    select: { status: true },
  });
  const booking = await prisma.client.booking.findUniqueOrThrow({
    where: { id: fixture.bookingId },
    select: { status: true },
  });
  const seat = await prisma.client.screeningSeat.findUniqueOrThrow({
    where: { id: fixture.screeningSeatId },
    select: { status: true },
  });
  const reconciliations = await prisma.client.paymentReconciliation.findMany({
    where: { paymentId: fixture.paymentId },
    select: { status: true },
  });

  return {
    paymentStatus: payment.status,
    bookingStatus: booking.status,
    seatStatus: seat.status,
    reconciliationStatus: reconciliations[0]?.status ?? null,
    reconciliationCount: reconciliations.length,
  };
}

async function deleteFixture(prisma: PrismaService, fixture: Fixture) {
  await prisma.client.refund.deleteMany({ where: { paymentId: fixture.paymentId } });
  await prisma.client.paymentReconciliation.deleteMany({
    where: { paymentId: fixture.paymentId },
  });
  await prisma.client.payment.deleteMany({ where: { bookingId: fixture.bookingId } });
  await prisma.client.bookingSeat.deleteMany({ where: { bookingId: fixture.bookingId } });
  await prisma.client.booking.delete({ where: { id: fixture.bookingId } });
  await prisma.client.screeningSeat.delete({ where: { id: fixture.screeningSeatId } });
  await prisma.client.seat.deleteMany({ where: { screenId: fixture.screenId } });
  await prisma.client.screening.delete({ where: { id: fixture.screeningId } });
  await prisma.client.screen.delete({ where: { id: fixture.screenId } });
  await prisma.client.movie.delete({ where: { id: fixture.movieId } });
  await prisma.client.user.delete({ where: { id: fixture.userId } });
}
