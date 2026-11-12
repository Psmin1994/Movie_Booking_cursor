/**
 * Test Intent:
 * 만료된 AUTHORIZING Payment가 Recover → Reconcile(PAID) → fire-and-forget ProcessRefundWorker를
 * 실제 Nest DI와 PostgreSQL로 거치면 Payment PAID, Refund COMPLETED, Reconciliation COMPLETED·REFUND_CREATED가 되고
 * Booking CANCELLED와 Seat AVAILABLE은 복구되지 않는다.
 */

import { randomInt, randomUUID } from "node:crypto";
import { jest } from "@jest/globals";
import { INestApplication, Logger } from "@nestjs/common";
import { App } from "supertest/types";
import {
  BOOKING_CANCELLED_STATUS,
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
  PAYMENT_RECONCILIATION_REQUIRED_STATUS,
  RECONCILE_PAYMENT_RESULT,
  RECONCILIATION_COMPLETED_STATUS,
  RECONCILIATION_RESULT_REFUND_CREATED,
  RECONCILIATION_SCHEDULED_STATUS,
  RECOVER_AUTHORIZING_PAYMENT_RESULT,
} from "../src/payment/payment.constants.js";
import { ExpirePaymentScheduler } from "../src/payment/scheduler/expire-payment.scheduler.js";
import { ReconcilePaymentScheduler } from "../src/payment/scheduler/reconcile-payment.scheduler.js";
import { RecoverAuthorizingPaymentScheduler } from "../src/payment/scheduler/recover-authorizing-payment.scheduler.js";
import { ReconcilePaymentService } from "../src/payment/use-case/reconcile-payment.service.js";
import { RecoverAuthorizingPaymentService } from "../src/payment/use-case/recover-authorizing-payment.service.js";
import {
  PROCESS_REFUND_RESULT,
  REFUND_COMPLETED_STATUS,
} from "../src/refund/refund.constants.js";
import { ProcessRefundScheduler } from "../src/refund/scheduler/process-refund.scheduler.js";
import {
  ProcessRefundService,
  type ProcessRefundResult,
} from "../src/refund/use-case/process-refund.service.js";
import { createTestApp } from "./helpers/create-test-app.js";

jest.setTimeout(30_000);

const AMOUNT = 14_000;

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
  paymentKey: string;
  amount: number;
};

type GatewayCall =
  | { method: "retrieve"; input: PaymentGatewayRetrieveInput }
  | { method: "cancel"; input: PaymentGatewayCancelInput }
  | { method: "retrieveCancelOutcome"; input: PaymentGatewayRetrieveCancelOutcomeInput }
  | { method: "confirm"; input: PaymentGatewayConfirmInput };

class JourneyPaymentGateway extends PaymentGateway {
  calls: GatewayCall[] = [];
  private paidIdentity: {
    paymentKey: string;
    orderId: string;
    amount: number;
  } | null = null;

  setPaidIdentity(identity: { paymentKey: string; orderId: string; amount: number }) {
    this.paidIdentity = identity;
  }

  reset() {
    this.calls = [];
    this.paidIdentity = null;
  }

  confirm(input: PaymentGatewayConfirmInput): Promise<PaymentGatewayConfirmResult> {
    this.calls.push({ method: "confirm", input });
    return Promise.resolve({ status: "UNKNOWN" });
  }

  retrieve(input: PaymentGatewayRetrieveInput): Promise<PaymentGatewayRetrieveResult> {
    this.calls.push({ method: "retrieve", input });
    if (!this.paidIdentity) {
      return Promise.resolve({ status: "UNKNOWN" });
    }

    return Promise.resolve({
      status: "PAID",
      paymentKey: this.paidIdentity.paymentKey,
      orderId: this.paidIdentity.orderId,
      amount: this.paidIdentity.amount,
      approvedAt: new Date("2026-10-31T12:00:00.000Z"),
    });
  }

  cancel(input: PaymentGatewayCancelInput): Promise<PaymentGatewayCancelResult> {
    this.calls.push({ method: "cancel", input });
    return Promise.resolve({
      status: "SUCCESS",
      paymentKey: input.paymentKey,
      cancelAmount: input.cancelAmount,
      transactionKey: `txn-${input.idempotencyKey}`,
    });
  }

  retrieveCancelOutcome(
    input: PaymentGatewayRetrieveCancelOutcomeInput,
  ): Promise<PaymentGatewayRetrieveCancelOutcomeResult> {
    this.calls.push({ method: "retrieveCancelOutcome", input });
    return Promise.resolve({
      status: "CANCELED",
      paymentKey: input.paymentKey,
      transactionKey: input.transactionKey,
      cancelAmount: input.cancelAmount,
    });
  }
}

describe("Payment recovery to refund COMPLETED journey on PostgreSQL", () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let recoverAuthorizingPaymentService: RecoverAuthorizingPaymentService;
  let reconcilePaymentService: ReconcilePaymentService;
  let processRefundService: ProcessRefundService;
  const paymentGateway = new JourneyPaymentGateway();
  const refundJobs: Promise<ProcessRefundResult>[] = [];
  let executeSpy: jest.SpiedFunction<ProcessRefundService["execute"]>;
  let loggerError: jest.SpiedFunction<Logger["error"]>;

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
    recoverAuthorizingPaymentService = app.get(RecoverAuthorizingPaymentService);
    reconcilePaymentService = app.get(ReconcilePaymentService);
    processRefundService = app.get(ProcessRefundService);

    const originalExecute = processRefundService.execute.bind(processRefundService);
    executeSpy = jest
      .spyOn(processRefundService, "execute")
      .mockImplementation((refundId: string) => {
        const job = originalExecute(refundId);
        refundJobs.push(job);
        return job;
      });
  });

  beforeEach(() => {
    paymentGateway.reset();
    refundJobs.length = 0;
    executeSpy.mockClear();
    loggerError = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    loggerError.mockRestore();
  });

  afterAll(async () => {
    executeSpy.mockRestore();
    await app.close();
  });

  it("recovers authorizing payment, reconciles PAID, and completes refund via fire-and-forget worker", async () => {
    const fixture = await createFixture(prisma);
    paymentGateway.setPaidIdentity({
      paymentKey: fixture.paymentKey,
      orderId: fixture.orderId,
      amount: fixture.amount,
    });

    try {
      await expect(
        recoverAuthorizingPaymentService.execute(fixture.paymentId),
      ).resolves.toEqual({
        result: RECOVER_AUTHORIZING_PAYMENT_RESULT.RECONCILIATION_REQUIRED,
      });

      const afterRecovery = await readJourneyState(prisma, fixture);
      expect(afterRecovery.payment).toEqual({
        status: PAYMENT_RECONCILIATION_REQUIRED_STATUS,
        paidAt: null,
        paymentKey: fixture.paymentKey,
        orderId: fixture.orderId,
        amount: fixture.amount,
      });
      expect(afterRecovery.booking.status).toBe(BOOKING_CANCELLED_STATUS);
      expect(afterRecovery.booking.cancelledAt).not.toBeNull();
      expect(afterRecovery.screeningSeat.status).toBe(SCREENING_SEAT_AVAILABLE_STATUS);
      expect(afterRecovery.reconciliation).toEqual({
        status: RECONCILIATION_SCHEDULED_STATUS,
        result: null,
        completedAt: null,
        leaseToken: null,
        leaseUntil: null,
      });
      expect(afterRecovery.refund).toBeNull();

      const reconciliationId = (
        await prisma.client.paymentReconciliation.findUniqueOrThrow({
          where: { paymentId: fixture.paymentId },
          select: { id: true },
        })
      ).id;
      const cancelledAtAfterRecovery = afterRecovery.booking.cancelledAt;

      await expect(reconcilePaymentService.execute(reconciliationId)).resolves.toEqual({
        result: RECONCILE_PAYMENT_RESULT.PAID,
      });

      expect(executeSpy).toHaveBeenCalledTimes(1);
      expect(refundJobs).toHaveLength(1);
      await expect(refundJobs[0]).resolves.toEqual({
        result: PROCESS_REFUND_RESULT.COMPLETED,
      });
      expect(executeSpy).toHaveBeenCalledTimes(1);

      const finalState = await readJourneyState(prisma, fixture);
      expect(finalState.payment).toEqual({
        status: PAYMENT_PAID_STATUS,
        paidAt: expect.any(Date),
        paymentKey: fixture.paymentKey,
        orderId: fixture.orderId,
        amount: fixture.amount,
      });
      expect(finalState.booking).toEqual({
        status: BOOKING_CANCELLED_STATUS,
        cancelledAt: cancelledAtAfterRecovery,
      });
      expect(finalState.screeningSeat.status).toBe(SCREENING_SEAT_AVAILABLE_STATUS);
      expect(finalState.reconciliation).toEqual({
        status: RECONCILIATION_COMPLETED_STATUS,
        result: RECONCILIATION_RESULT_REFUND_CREATED,
        completedAt: expect.any(Date),
        leaseToken: null,
        leaseUntil: null,
      });
      expect(finalState.refund).toEqual({
        status: REFUND_COMPLETED_STATUS,
        transactionKey: expect.stringMatching(/^txn-/),
        cancelRequestedAt: expect.any(Date),
        completedAt: expect.any(Date),
        failedAt: null,
        leaseToken: null,
        leaseUntil: null,
        amount: fixture.amount,
        paymentKey: fixture.paymentKey,
      });

      expect(paymentGateway.calls.map((call) => call.method)).toEqual([
        "retrieve",
        "cancel",
        "retrieveCancelOutcome",
      ]);
      expect(paymentGateway.calls[0]).toEqual({
        method: "retrieve",
        input: { paymentKey: fixture.paymentKey },
      });
      expect(paymentGateway.calls[1]).toEqual({
        method: "cancel",
        input: expect.objectContaining({
          paymentKey: fixture.paymentKey,
          cancelAmount: fixture.amount,
          idempotencyKey: expect.any(String),
        }),
      });
      const cancelCall = paymentGateway.calls[1];
      if (!cancelCall || cancelCall.method !== "cancel") {
        throw new Error("Expected cancel gateway call");
      }
      expect(paymentGateway.calls[2]).toEqual({
        method: "retrieveCancelOutcome",
        input: {
          paymentKey: fixture.paymentKey,
          transactionKey: `txn-${cancelCall.input.idempotencyKey}`,
          cancelAmount: fixture.amount,
        },
      });
      expect(loggerError).not.toHaveBeenCalled();
    } finally {
      await deleteFixture(prisma, fixture);
    }
  });
});

async function createFixture(prisma: PrismaService): Promise<Fixture> {
  const suffix = randomUUID();
  const orderId = `ord_${suffix}`;
  const paymentKey = `pay_${suffix}`;
  const user = await prisma.client.user.create({
    data: {
      email: `payment-recovery-refund-journey-${suffix}@example.com`,
      passwordHash: "test-hash",
      name: "Payment Recovery Refund Journey",
    },
  });
  const movie = await prisma.client.movie.create({
    data: {
      title: `payment-recovery-refund-journey-${suffix}`,
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
      row: "J",
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
      expiresAt: new Date(Date.now() + 60_000),
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
      paymentKey,
      status: PAYMENT_AUTHORIZING_STATUS,
      amount: AMOUNT,
      authorizationExpiresAt: new Date(Date.now() - 60_000),
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
    paymentKey,
    amount: AMOUNT,
  };
}

async function readJourneyState(prisma: PrismaService, fixture: Fixture) {
  const payment = await prisma.client.payment.findUniqueOrThrow({
    where: { id: fixture.paymentId },
    select: {
      status: true,
      paidAt: true,
      paymentKey: true,
      orderId: true,
      amount: true,
    },
  });
  const booking = await prisma.client.booking.findUniqueOrThrow({
    where: { id: fixture.bookingId },
    select: { status: true, cancelledAt: true },
  });
  const screeningSeat = await prisma.client.screeningSeat.findUniqueOrThrow({
    where: { id: fixture.screeningSeatId },
    select: { status: true },
  });
  const reconciliation = await prisma.client.paymentReconciliation.findUnique({
    where: { paymentId: fixture.paymentId },
    select: {
      status: true,
      result: true,
      completedAt: true,
      leaseToken: true,
      leaseUntil: true,
    },
  });
  const refund = await prisma.client.refund.findUnique({
    where: { paymentId: fixture.paymentId },
    select: {
      status: true,
      transactionKey: true,
      cancelRequestedAt: true,
      completedAt: true,
      failedAt: true,
      leaseToken: true,
      leaseUntil: true,
      amount: true,
      paymentKey: true,
    },
  });

  return { payment, booking, screeningSeat, reconciliation, refund };
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
