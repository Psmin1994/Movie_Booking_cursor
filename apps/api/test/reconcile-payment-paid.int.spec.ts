/**
 * Test Intent:
 * Gateway retrieve가 PAID이고 identity·amount가 일치하면 Payment는 PAID, Booking은 CANCELLED, ScreeningSeat는 AVAILABLE,
 * Refund는 PENDING, Reconciliation은 COMPLETED·REFUND_CREATED가 된다.
 * PAID Transaction 중간에서 Lease fencing이 실패하면 Payment·Refund·Reconciliation 변경이 모두 rollback된다.
 * Commit 이후 ProcessRefundService 호출 실패는 이미 생성된 PENDING Refund를 보존한다.
 */

import { randomInt, randomUUID } from "node:crypto";
import { jest } from "@jest/globals";
import { INestApplication, Logger } from "@nestjs/common";
import { App } from "supertest/types";
import {
  BOOKING_CANCELLED_STATUS,
  SCREENING_SEAT_AVAILABLE_STATUS,
} from "../src/booking/booking.constants.js";
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
  PAYMENT_PAID_STATUS,
  PAYMENT_RECONCILIATION_REQUIRED_STATUS,
  RECONCILE_PAYMENT_RESULT,
  RECONCILIATION_COMPLETED_STATUS,
  RECONCILIATION_RESULT_REFUND_CREATED,
  RECONCILIATION_SCHEDULED_STATUS,
} from "../src/payment/payment.constants.js";
import { ReconcilePaymentService } from "../src/payment/use-case/reconcile-payment.service.js";
import { REFUND_PENDING_STATUS } from "../src/refund/refund.constants.js";
import { ProcessRefundService } from "../src/refund/use-case/process-refund.service.js";
import { createTestApp } from "./helpers/create-test-app.js";

jest.setTimeout(30_000);

const AMOUNT = 12_000;

type Fixture = {
  userId: string;
  movieId: string;
  screenId: string;
  screeningId: string;
  screeningSeatId: string;
  bookingId: string;
  paymentId: string;
  reconciliationId: string;
  orderId: string;
  paymentKey: string;
};

class ScriptableRetrieveGateway extends PaymentGateway {
  retrieveImpl: (
    input: PaymentGatewayRetrieveInput,
  ) => Promise<PaymentGatewayRetrieveResult> = async () => ({ status: "UNKNOWN" });

  confirm(input: PaymentGatewayConfirmInput): Promise<PaymentGatewayConfirmResult> {
    return Promise.resolve({
      status: "SUCCESS",
      paymentKey: input.paymentKey,
      orderId: input.orderId,
      amount: input.amount,
      approvedAt: new Date(),
    });
  }

  retrieve(input: PaymentGatewayRetrieveInput): Promise<PaymentGatewayRetrieveResult> {
    return this.retrieveImpl(input);
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

describe("ReconcilePaymentService PAID on PostgreSQL", () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let reconcilePaymentService: ReconcilePaymentService;
  const paymentGateway = new ScriptableRetrieveGateway();
  const processRefundService = {
    execute: jest.fn<ProcessRefundService["execute"]>().mockResolvedValue({
      result: "PENDING",
    }),
  };

  beforeAll(async () => {
    app = await createTestApp((builder) =>
      builder
        .overrideProvider(PaymentGateway)
        .useValue(paymentGateway)
        .overrideProvider(ProcessRefundService)
        .useValue(processRefundService),
    );
    prisma = app.get(PrismaService);
    reconcilePaymentService = app.get(ReconcilePaymentService);
  });

  beforeEach(() => {
    processRefundService.execute.mockClear();
    processRefundService.execute.mockResolvedValue({ result: "PENDING" });
    paymentGateway.retrieveImpl = async () => ({ status: "UNKNOWN" });
  });

  afterAll(async () => {
    await app.close();
  });

  it("confirms PAID payment, keeps cancelled booking seats available, and creates a pending refund", async () => {
    const fixture = await createFixture(prisma);
    paymentGateway.retrieveImpl = async () => ({
      status: "PAID",
      paymentKey: fixture.paymentKey,
      orderId: fixture.orderId,
      amount: AMOUNT,
      approvedAt: new Date("2026-10-31T12:00:00.000Z"),
    });

    await expect(reconcilePaymentService.execute(fixture.reconciliationId)).resolves.toEqual({
      result: RECONCILE_PAYMENT_RESULT.PAID,
    });

    const payment = await prisma.client.payment.findUniqueOrThrow({
      where: { id: fixture.paymentId },
      select: { status: true, paidAt: true },
    });
    const booking = await prisma.client.booking.findUniqueOrThrow({
      where: { id: fixture.bookingId },
      select: { status: true },
    });
    const screeningSeat = await prisma.client.screeningSeat.findUniqueOrThrow({
      where: { id: fixture.screeningSeatId },
      select: { status: true },
    });
    const refund = await prisma.client.refund.findUnique({
      where: { paymentId: fixture.paymentId },
      select: { status: true, amount: true, paymentKey: true },
    });
    const reconciliation = await prisma.client.paymentReconciliation.findUniqueOrThrow({
      where: { id: fixture.reconciliationId },
      select: {
        status: true,
        result: true,
        completedAt: true,
        leaseToken: true,
        leaseUntil: true,
      },
    });

    expect(payment.status).toBe(PAYMENT_PAID_STATUS);
    expect(payment.paidAt).not.toBeNull();
    expect(booking.status).toBe(BOOKING_CANCELLED_STATUS);
    expect(screeningSeat.status).toBe(SCREENING_SEAT_AVAILABLE_STATUS);
    expect(refund).toEqual({
      status: REFUND_PENDING_STATUS,
      amount: AMOUNT,
      paymentKey: fixture.paymentKey,
    });
    expect(reconciliation).toEqual({
      status: RECONCILIATION_COMPLETED_STATUS,
      result: RECONCILIATION_RESULT_REFUND_CREATED,
      completedAt: expect.any(Date),
      leaseToken: null,
      leaseUntil: null,
    });
    expect(processRefundService.execute).toHaveBeenCalledWith(expect.any(String));

    await deleteFixture(prisma, fixture);
  });

  it("rolls back payment and refund changes when lease fencing fails mid-transaction", async () => {
    const fixture = await createFixture(prisma);
    paymentGateway.retrieveImpl = async () => {
      await prisma.client.paymentReconciliation.update({
        where: { id: fixture.reconciliationId },
        data: {
          leaseUntil: new Date(Date.now() - 1_000),
        },
      });

      return {
        status: "PAID",
        paymentKey: fixture.paymentKey,
        orderId: fixture.orderId,
        amount: AMOUNT,
        approvedAt: new Date("2026-10-31T12:00:00.000Z"),
      };
    };

    await expect(reconcilePaymentService.execute(fixture.reconciliationId)).rejects.toThrow();

    const payment = await prisma.client.payment.findUniqueOrThrow({
      where: { id: fixture.paymentId },
      select: { status: true, paidAt: true },
    });
    const refund = await prisma.client.refund.findUnique({
      where: { paymentId: fixture.paymentId },
      select: { id: true },
    });
    const reconciliation = await prisma.client.paymentReconciliation.findUniqueOrThrow({
      where: { id: fixture.reconciliationId },
      select: {
        status: true,
        result: true,
        completedAt: true,
      },
    });

    expect(payment).toEqual({
      status: PAYMENT_RECONCILIATION_REQUIRED_STATUS,
      paidAt: null,
    });
    expect(refund).toBeNull();
    expect(reconciliation).toEqual({
      status: RECONCILIATION_SCHEDULED_STATUS,
      result: null,
      completedAt: null,
    });
    expect(processRefundService.execute).not.toHaveBeenCalled();

    await deleteFixture(prisma, fixture);
  });

  it("keeps the pending refund when ProcessRefundService fails after commit", async () => {
    const fixture = await createFixture(prisma);
    paymentGateway.retrieveImpl = async () => ({
      status: "PAID",
      paymentKey: fixture.paymentKey,
      orderId: fixture.orderId,
      amount: AMOUNT,
      approvedAt: new Date("2026-10-31T12:00:00.000Z"),
    });
    const workerError = new Error("worker failed");
    processRefundService.execute.mockRejectedValue(workerError);
    const loggerError = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);

    await expect(reconcilePaymentService.execute(fixture.reconciliationId)).resolves.toEqual({
      result: RECONCILE_PAYMENT_RESULT.PAID,
    });

    await Promise.resolve();

    const refund = await prisma.client.refund.findUniqueOrThrow({
      where: { paymentId: fixture.paymentId },
      select: { id: true, status: true },
    });

    expect(refund.status).toBe(REFUND_PENDING_STATUS);
    expect(processRefundService.execute).toHaveBeenCalledWith(refund.id);
    expect(loggerError).toHaveBeenCalledWith(
      `Failed to process refund ${refund.id}`,
      workerError.stack,
    );

    loggerError.mockRestore();
    await deleteFixture(prisma, fixture);
  });
});

async function createFixture(prisma: PrismaService): Promise<Fixture> {
  const suffix = randomUUID();
  const user = await prisma.client.user.create({
    data: {
      email: `reconcile-paid-int-${suffix}@example.com`,
      passwordHash: "test-hash",
      name: "Reconcile Paid Integration",
    },
  });
  const movie = await prisma.client.movie.create({
    data: {
      title: `reconcile-paid-int-${suffix}`,
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
      status: SCREENING_SEAT_AVAILABLE_STATUS,
    },
  });
  const booking = await prisma.client.booking.create({
    data: {
      userId: user.id,
      screeningId: screening.id,
      status: BOOKING_CANCELLED_STATUS,
      totalAmount: AMOUNT,
      expiresAt: new Date(Date.now() + 60_000),
      cancelledAt: new Date("2026-10-31T11:00:00.000Z"),
    },
  });
  await prisma.client.bookingSeat.create({
    data: {
      bookingId: booking.id,
      screeningSeatId: screeningSeat.id,
    },
  });
  const orderId = `ord_${suffix}`;
  const paymentKey = `pay_${suffix}`;
  const payment = await prisma.client.payment.create({
    data: {
      bookingId: booking.id,
      orderId,
      paymentKey,
      status: PAYMENT_RECONCILIATION_REQUIRED_STATUS,
      amount: AMOUNT,
    },
  });
  const now = Date.now();
  const openedAt = new Date(now - 60_000);
  const reconciliation = await prisma.client.paymentReconciliation.create({
    data: {
      paymentId: payment.id,
      status: RECONCILIATION_SCHEDULED_STATUS,
      createdAt: openedAt,
      nextProcessAt: openedAt,
      retryDeadline: new Date(now + 10 * 60_000),
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
    reconciliationId: reconciliation.id,
    orderId,
    paymentKey,
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
