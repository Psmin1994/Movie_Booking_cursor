/**
 * Test Intent:
 * Gateway NOT_PAID면 Payment FAILED와 Reconciliation COMPLETED·NOT_PAID가 한 트랜잭션으로 확정되고 Refund는 없다.
 * 그 트랜잭션에서 Lease fencing이 실패하면 Payment·Reconciliation 변경이 모두 rollback된다.
 * Gateway UNKNOWN이면 Payment/Booking/Seat는 유지하고 nextProcessAt만 +1분 갱신하며 result·retryDeadline·Lease는 유지한다.
 * UNKNOWN reschedule이 Lease fencing에 실패하면 nextProcessAt은 갱신되지 않는다.
 * UNKNOWN 이후 Deadline·Lease를 만료시키면 Claim은 차단되고 Sweep으로 REVIEW·UNRESOLVED·Lease 해제가 된다.
 */

import { randomInt, randomUUID } from "node:crypto";
import { jest } from "@jest/globals";
import { INestApplication } from "@nestjs/common";
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
  CLAIM_RECONCILIATION_RESULT,
  PAYMENT_FAILED_STATUS,
  PAYMENT_RECONCILIATION_REQUIRED_STATUS,
  RECONCILE_PAYMENT_RESULT,
  RECONCILIATION_COMPLETED_STATUS,
  RECONCILIATION_RESULT_NOT_PAID,
  RECONCILIATION_RESULT_UNRESOLVED,
  RECONCILIATION_REVIEW_STATUS,
  RECONCILIATION_SCHEDULED_STATUS,
} from "../src/payment/payment.constants.js";
import { AUTOMATIC_RETRIEVE_INTERVAL_MS } from "../src/payment/reconciliation-schedule.js";
import { ReconcilePaymentRepository } from "../src/payment/repository/reconcile-payment.repository.js";
import { ReconcilePaymentScheduler } from "../src/payment/scheduler/reconcile-payment.scheduler.js";
import { ReconcilePaymentService } from "../src/payment/use-case/reconcile-payment.service.js";
import { createTestApp } from "./helpers/create-test-app.js";

jest.setTimeout(30_000);

const AMOUNT = 13_000;

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
  openedAt: Date;
  retryDeadline: Date;
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

describe("ReconcilePaymentService NOT_PAID and UNKNOWN on PostgreSQL", () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let reconcilePaymentService: ReconcilePaymentService;
  let reconcilePaymentRepository: ReconcilePaymentRepository;
  let reconcilePaymentScheduler: ReconcilePaymentScheduler;
  const paymentGateway = new ScriptableRetrieveGateway();

  beforeAll(async () => {
    app = await createTestApp((builder) =>
      builder.overrideProvider(PaymentGateway).useValue(paymentGateway),
    );
    prisma = app.get(PrismaService);
    reconcilePaymentService = app.get(ReconcilePaymentService);
    reconcilePaymentRepository = app.get(ReconcilePaymentRepository);
    reconcilePaymentScheduler = app.get(ReconcilePaymentScheduler);
  });

  beforeEach(() => {
    paymentGateway.retrieveImpl = async () => ({ status: "UNKNOWN" });
  });

  afterAll(async () => {
    await app.close();
  });

  it("fails payment and completes reconciliation as NOT_PAID without creating a refund", async () => {
    const fixture = await createFixture(prisma);
    paymentGateway.retrieveImpl = async () => ({ status: "NOT_PAID" });

    await expect(reconcilePaymentService.execute(fixture.reconciliationId)).resolves.toEqual({
      result: RECONCILE_PAYMENT_RESULT.NOT_PAID,
    });

    const payment = await prisma.client.payment.findUniqueOrThrow({
      where: { id: fixture.paymentId },
      select: { status: true, failedAt: true },
    });
    const booking = await prisma.client.booking.findUniqueOrThrow({
      where: { id: fixture.bookingId },
      select: { status: true },
    });
    const screeningSeat = await prisma.client.screeningSeat.findUniqueOrThrow({
      where: { id: fixture.screeningSeatId },
      select: { status: true },
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
    const refund = await prisma.client.refund.findUnique({
      where: { paymentId: fixture.paymentId },
      select: { id: true },
    });

    expect(payment.status).toBe(PAYMENT_FAILED_STATUS);
    expect(payment.failedAt).not.toBeNull();
    expect(booking.status).toBe(BOOKING_CANCELLED_STATUS);
    expect(screeningSeat.status).toBe(SCREENING_SEAT_AVAILABLE_STATUS);
    expect(reconciliation).toEqual({
      status: RECONCILIATION_COMPLETED_STATUS,
      result: RECONCILIATION_RESULT_NOT_PAID,
      completedAt: expect.any(Date),
      leaseToken: null,
      leaseUntil: null,
    });
    expect(refund).toBeNull();

    await deleteFixture(prisma, fixture);
  });

  it("rolls back NOT_PAID payment changes when lease fencing fails mid-transaction", async () => {
    const fixture = await createFixture(prisma);
    paymentGateway.retrieveImpl = async () => {
      await prisma.client.paymentReconciliation.update({
        where: { id: fixture.reconciliationId },
        data: {
          leaseUntil: new Date(Date.now() - 1_000),
        },
      });
      return { status: "NOT_PAID" };
    };

    await expect(reconcilePaymentService.execute(fixture.reconciliationId)).rejects.toThrow();

    const payment = await prisma.client.payment.findUniqueOrThrow({
      where: { id: fixture.paymentId },
      select: { status: true, failedAt: true },
    });
    const reconciliation = await prisma.client.paymentReconciliation.findUniqueOrThrow({
      where: { id: fixture.reconciliationId },
      select: {
        status: true,
        result: true,
        completedAt: true,
      },
    });
    const refund = await prisma.client.refund.findUnique({
      where: { paymentId: fixture.paymentId },
      select: { id: true },
    });

    expect(payment).toEqual({
      status: PAYMENT_RECONCILIATION_REQUIRED_STATUS,
      failedAt: null,
    });
    expect(reconciliation).toEqual({
      status: RECONCILIATION_SCHEDULED_STATUS,
      result: null,
      completedAt: null,
    });
    expect(refund).toBeNull();

    await deleteFixture(prisma, fixture);
  });

  it("reschedules UNKNOWN without changing payment, result, retryDeadline, or releasing the lease", async () => {
    const fixture = await createFixture(prisma);
    paymentGateway.retrieveImpl = async () => ({ status: "UNKNOWN" });

    const beforeMs = Date.now();
    await expect(reconcilePaymentService.execute(fixture.reconciliationId)).resolves.toEqual({
      result: RECONCILE_PAYMENT_RESULT.UNKNOWN,
    });
    const afterMs = Date.now();

    const payment = await prisma.client.payment.findUniqueOrThrow({
      where: { id: fixture.paymentId },
      select: { status: true },
    });
    const booking = await prisma.client.booking.findUniqueOrThrow({
      where: { id: fixture.bookingId },
      select: { status: true },
    });
    const screeningSeat = await prisma.client.screeningSeat.findUniqueOrThrow({
      where: { id: fixture.screeningSeatId },
      select: { status: true },
    });
    const reconciliation = await prisma.client.paymentReconciliation.findUniqueOrThrow({
      where: { id: fixture.reconciliationId },
      select: {
        status: true,
        result: true,
        nextProcessAt: true,
        retryDeadline: true,
        leaseToken: true,
        leaseUntil: true,
        completedAt: true,
      },
    });
    const refund = await prisma.client.refund.findUnique({
      where: { paymentId: fixture.paymentId },
      select: { id: true },
    });

    expect(payment.status).toBe(PAYMENT_RECONCILIATION_REQUIRED_STATUS);
    expect(booking.status).toBe(BOOKING_CANCELLED_STATUS);
    expect(screeningSeat.status).toBe(SCREENING_SEAT_AVAILABLE_STATUS);
    expect(reconciliation.status).toBe(RECONCILIATION_SCHEDULED_STATUS);
    expect(reconciliation.result).toBeNull();
    expect(reconciliation.completedAt).toBeNull();
    expect(reconciliation.retryDeadline).toEqual(fixture.retryDeadline);
    expect(reconciliation.leaseToken).not.toBeNull();
    expect(reconciliation.leaseUntil).not.toBeNull();
    expect(reconciliation.nextProcessAt).not.toBeNull();
    expect(reconciliation.nextProcessAt!.getTime()).toBeGreaterThanOrEqual(
      beforeMs + AUTOMATIC_RETRIEVE_INTERVAL_MS,
    );
    expect(reconciliation.nextProcessAt!.getTime()).toBeLessThanOrEqual(
      afterMs + AUTOMATIC_RETRIEVE_INTERVAL_MS,
    );
    expect(refund).toBeNull();

    await deleteFixture(prisma, fixture);
  });

  it("does not advance nextProcessAt when UNKNOWN reschedule loses the lease", async () => {
    const fixture = await createFixture(prisma);
    paymentGateway.retrieveImpl = async () => {
      await prisma.client.paymentReconciliation.update({
        where: { id: fixture.reconciliationId },
        data: {
          leaseUntil: new Date(Date.now() - 1_000),
        },
      });
      return { status: "UNKNOWN" };
    };

    await expect(reconcilePaymentService.execute(fixture.reconciliationId)).rejects.toThrow();

    const payment = await prisma.client.payment.findUniqueOrThrow({
      where: { id: fixture.paymentId },
      select: { status: true },
    });
    const booking = await prisma.client.booking.findUniqueOrThrow({
      where: { id: fixture.bookingId },
      select: { status: true },
    });
    const screeningSeat = await prisma.client.screeningSeat.findUniqueOrThrow({
      where: { id: fixture.screeningSeatId },
      select: { status: true },
    });
    const reconciliation = await prisma.client.paymentReconciliation.findUniqueOrThrow({
      where: { id: fixture.reconciliationId },
      select: {
        status: true,
        result: true,
        nextProcessAt: true,
        retryDeadline: true,
        completedAt: true,
      },
    });
    const refund = await prisma.client.refund.findUnique({
      where: { paymentId: fixture.paymentId },
      select: { id: true },
    });

    expect(payment.status).toBe(PAYMENT_RECONCILIATION_REQUIRED_STATUS);
    expect(booking.status).toBe(BOOKING_CANCELLED_STATUS);
    expect(screeningSeat.status).toBe(SCREENING_SEAT_AVAILABLE_STATUS);
    expect(reconciliation).toEqual({
      status: RECONCILIATION_SCHEDULED_STATUS,
      result: null,
      nextProcessAt: fixture.openedAt,
      retryDeadline: fixture.retryDeadline,
      completedAt: null,
    });
    expect(refund).toBeNull();

    await deleteFixture(prisma, fixture);
  });

  it("after UNKNOWN, past deadline with expired lease blocks claim and sweep marks REVIEW", async () => {
    const fixture = await createFixture(prisma);
    paymentGateway.retrieveImpl = async () => ({ status: "UNKNOWN" });

    await expect(reconcilePaymentService.execute(fixture.reconciliationId)).resolves.toEqual({
      result: RECONCILE_PAYMENT_RESULT.UNKNOWN,
    });

    const afterUnknown = await prisma.client.paymentReconciliation.findUniqueOrThrow({
      where: { id: fixture.reconciliationId },
      select: { nextProcessAt: true, leaseToken: true },
    });
    expect(afterUnknown.leaseToken).not.toBeNull();

    // nextProcessAt·Lease는 Claim 가능 조건으로 두고, retryDeadline만 만료시켜
    // Claim 차단 원인이 Deadline임을 보장한다.
    const boundaryNow = new Date();
    await prisma.client.paymentReconciliation.update({
      where: { id: fixture.reconciliationId },
      data: {
        nextProcessAt: new Date(boundaryNow.getTime() - 1_000),
        retryDeadline: new Date(boundaryNow.getTime() - 1),
        leaseUntil: new Date(boundaryNow.getTime() - 1),
      },
    });

    await expect(
      prisma.client.$transaction((tx) =>
        reconcilePaymentRepository.claimDue(tx, fixture.reconciliationId, boundaryNow),
      ),
    ).resolves.toEqual({
      result: CLAIM_RECONCILIATION_RESULT.NOT_CLAIMED,
    });

    await reconcilePaymentScheduler.processDueReconciliations();

    const payment = await prisma.client.payment.findUniqueOrThrow({
      where: { id: fixture.paymentId },
      select: { status: true },
    });
    const booking = await prisma.client.booking.findUniqueOrThrow({
      where: { id: fixture.bookingId },
      select: { status: true },
    });
    const screeningSeat = await prisma.client.screeningSeat.findUniqueOrThrow({
      where: { id: fixture.screeningSeatId },
      select: { status: true },
    });
    const reconciliation = await prisma.client.paymentReconciliation.findUniqueOrThrow({
      where: { id: fixture.reconciliationId },
      select: {
        status: true,
        result: true,
        leaseToken: true,
        leaseUntil: true,
      },
    });

    expect(payment.status).toBe(PAYMENT_RECONCILIATION_REQUIRED_STATUS);
    expect(booking.status).toBe(BOOKING_CANCELLED_STATUS);
    expect(screeningSeat.status).toBe(SCREENING_SEAT_AVAILABLE_STATUS);
    expect(reconciliation).toEqual({
      status: RECONCILIATION_REVIEW_STATUS,
      result: RECONCILIATION_RESULT_UNRESOLVED,
      leaseToken: null,
      leaseUntil: null,
    });

    await deleteFixture(prisma, fixture);
  });
});

async function createFixture(prisma: PrismaService): Promise<Fixture> {
  const suffix = randomUUID();
  const user = await prisma.client.user.create({
    data: {
      email: `reconcile-outcome-int-${suffix}@example.com`,
      passwordHash: "test-hash",
      name: "Reconcile Outcome Integration",
    },
  });
  const movie = await prisma.client.movie.create({
    data: {
      title: `reconcile-outcome-int-${suffix}`,
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
      row: "O",
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
  const retryDeadline = new Date(now + 10 * 60_000);
  const reconciliation = await prisma.client.paymentReconciliation.create({
    data: {
      paymentId: payment.id,
      status: RECONCILIATION_SCHEDULED_STATUS,
      createdAt: openedAt,
      nextProcessAt: openedAt,
      retryDeadline,
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
    openedAt,
    retryDeadline,
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
