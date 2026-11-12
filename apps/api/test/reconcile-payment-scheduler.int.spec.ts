/**
 * Test Intent:
 * Scheduler Leading/Trailing Sweep이 past-deadline SCHEDULED 행을 REVIEW·UNRESOLVED로 바꾸고 만료 Lease를 해제한다.
 * 활성 Lease 행은 Sweep에서 제외되며, 해당 Worker는 유효 Lease로 완료할 수 있다.
 * Lease 만료 후에는 Sweep이 REVIEW로 전환하고 Lease 필드를 정리한다.
 */

import { randomInt, randomUUID } from "node:crypto";
import { jest } from "@jest/globals";
import { INestApplication } from "@nestjs/common";
import { App } from "supertest/types";
import { BOOKING_CANCELLED_STATUS } from "../src/booking/booking.constants.js";
import { PrismaService } from "../src/database/prisma.service.js";
import {
  CLAIM_RECONCILIATION_RESULT,
  COMPLETE_RECONCILIATION_AS_NOT_PAID_RESULT,
  FAIL_RECONCILIATION_PAYMENT_RESULT,
  PAYMENT_FAILED_STATUS,
  PAYMENT_RECONCILIATION_REQUIRED_STATUS,
  RECONCILIATION_COMPLETED_STATUS,
  RECONCILIATION_LEASE_TTL_MS,
  RECONCILIATION_RESULT_NOT_PAID,
  RECONCILIATION_RESULT_UNRESOLVED,
  RECONCILIATION_REVIEW_STATUS,
  RECONCILIATION_SCHEDULED_STATUS,
} from "../src/payment/payment.constants.js";
import { PaymentRepository } from "../src/payment/repository/payment.repository.js";
import { ReconcilePaymentRepository } from "../src/payment/repository/reconcile-payment.repository.js";
import { ReconcilePaymentScheduler } from "../src/payment/scheduler/reconcile-payment.scheduler.js";
import { createTestApp } from "./helpers/create-test-app.js";

jest.setTimeout(30_000);

const AMOUNT = 11_000;

type Fixture = {
  userId: string;
  movieId: string;
  screenId: string;
  screeningId: string;
  bookingId: string;
  paymentId: string;
  reconciliationId: string;
};

describe("ReconcilePaymentScheduler on PostgreSQL", () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let scheduler: ReconcilePaymentScheduler;
  let reconcilePaymentRepository: ReconcilePaymentRepository;
  let paymentRepository: PaymentRepository;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    scheduler = app.get(ReconcilePaymentScheduler);
    reconcilePaymentRepository = app.get(ReconcilePaymentRepository);
    paymentRepository = app.get(PaymentRepository);
  });

  afterAll(async () => {
    await app.close();
  });

  it("marks past-deadline reconciliations as REVIEW and clears expired leases", async () => {
    const now = new Date();
    const expiredToken = randomUUID();
    const fixture = await createFixture(prisma, {
      retryDeadline: new Date(now.getTime() - 1_000),
      nextProcessAt: new Date(now.getTime() - 60_000),
      leaseToken: expiredToken,
      leaseUntil: new Date(now.getTime() - 500),
    });

    await scheduler.processDueReconciliations();

    const reconciliation = await prisma.client.paymentReconciliation.findUniqueOrThrow({
      where: { id: fixture.reconciliationId },
      select: {
        status: true,
        result: true,
        leaseToken: true,
        leaseUntil: true,
      },
    });

    expect(reconciliation).toEqual({
      status: RECONCILIATION_REVIEW_STATUS,
      result: RECONCILIATION_RESULT_UNRESOLVED,
      leaseToken: null,
      leaseUntil: null,
    });

    await deleteFixture(prisma, fixture);
  });

  it("skips active leases during sweep while the holder can still complete", async () => {
    const now = new Date();
    const leaseToken = randomUUID();
    const leaseUntil = new Date(now.getTime() + RECONCILIATION_LEASE_TTL_MS);
    const fixture = await createFixture(prisma, {
      retryDeadline: new Date(now.getTime() - 1_000),
      nextProcessAt: new Date(now.getTime() - 60_000),
      leaseToken,
      leaseUntil,
    });

    await scheduler.processDueReconciliations();

    const afterSweep = await prisma.client.paymentReconciliation.findUniqueOrThrow({
      where: { id: fixture.reconciliationId },
      select: {
        status: true,
        result: true,
        leaseToken: true,
        leaseUntil: true,
      },
    });
    expect(afterSweep).toEqual({
      status: RECONCILIATION_SCHEDULED_STATUS,
      result: null,
      leaseToken,
      leaseUntil,
    });

    await prisma.client.$transaction(async (tx) => {
      const failed = await paymentRepository.failReconciliationPayment(
        tx,
        fixture.paymentId,
        now,
      );
      expect(failed.result).toBe(FAIL_RECONCILIATION_PAYMENT_RESULT.FAILED);

      const completed = await reconcilePaymentRepository.completeAsNotPaid(
        tx,
        fixture.reconciliationId,
        leaseToken,
        now,
      );
      expect(completed.result).toBe(COMPLETE_RECONCILIATION_AS_NOT_PAID_RESULT.COMPLETED);
    });

    const afterComplete = await prisma.client.paymentReconciliation.findUniqueOrThrow({
      where: { id: fixture.reconciliationId },
      select: {
        status: true,
        result: true,
        leaseToken: true,
        leaseUntil: true,
      },
    });
    const payment = await prisma.client.payment.findUniqueOrThrow({
      where: { id: fixture.paymentId },
      select: { status: true },
    });

    expect(payment.status).toBe(PAYMENT_FAILED_STATUS);
    expect(afterComplete).toEqual({
      status: RECONCILIATION_COMPLETED_STATUS,
      result: RECONCILIATION_RESULT_NOT_PAID,
      leaseToken: null,
      leaseUntil: null,
    });

    await deleteFixture(prisma, fixture);
  });

  it("does not claim a past-deadline row after sweep marks REVIEW", async () => {
    const now = new Date();
    const fixture = await createFixture(prisma, {
      retryDeadline: new Date(now.getTime() - 1_000),
      nextProcessAt: new Date(now.getTime() - 60_000),
    });

    await scheduler.processDueReconciliations();

    await expect(
      prisma.client.$transaction((tx) =>
        reconcilePaymentRepository.claimDue(tx, fixture.reconciliationId, now),
      ),
    ).resolves.toEqual({
      result: CLAIM_RECONCILIATION_RESULT.NOT_CLAIMED,
    });

    await deleteFixture(prisma, fixture);
  });
});

async function createFixture(
  prisma: PrismaService,
  input: {
    retryDeadline: Date;
    nextProcessAt: Date;
    leaseToken?: string | null;
    leaseUntil?: Date | null;
  },
): Promise<Fixture> {
  const suffix = randomUUID();
  const user = await prisma.client.user.create({
    data: {
      email: `reconcile-scheduler-int-${suffix}@example.com`,
      passwordHash: "test-hash",
      name: "Reconcile Scheduler Integration",
    },
  });
  const movie = await prisma.client.movie.create({
    data: {
      title: `reconcile-scheduler-int-${suffix}`,
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
  const payment = await prisma.client.payment.create({
    data: {
      bookingId: booking.id,
      orderId: `ord_${suffix}`,
      paymentKey: `pay_${suffix}`,
      status: PAYMENT_RECONCILIATION_REQUIRED_STATUS,
      amount: AMOUNT,
    },
  });
  const openedAt = new Date(input.retryDeadline.getTime() - 10 * 60_000);
  const reconciliation = await prisma.client.paymentReconciliation.create({
    data: {
      paymentId: payment.id,
      status: RECONCILIATION_SCHEDULED_STATUS,
      createdAt: openedAt,
      nextProcessAt: input.nextProcessAt,
      retryDeadline: input.retryDeadline,
      leaseToken: input.leaseToken === undefined ? null : input.leaseToken,
      leaseUntil: input.leaseUntil === undefined ? null : input.leaseUntil,
    },
  });

  return {
    userId: user.id,
    movieId: movie.id,
    screenId: screen.id,
    screeningId: screening.id,
    bookingId: booking.id,
    paymentId: payment.id,
    reconciliationId: reconciliation.id,
  };
}

async function deleteFixture(prisma: PrismaService, fixture: Fixture) {
  await prisma.client.refund.deleteMany({ where: { paymentId: fixture.paymentId } });
  await prisma.client.paymentReconciliation.deleteMany({
    where: { paymentId: fixture.paymentId },
  });
  await prisma.client.payment.deleteMany({ where: { bookingId: fixture.bookingId } });
  await prisma.client.booking.delete({ where: { id: fixture.bookingId } });
  await prisma.client.screening.delete({ where: { id: fixture.screeningId } });
  await prisma.client.screen.delete({ where: { id: fixture.screenId } });
  await prisma.client.movie.delete({ where: { id: fixture.movieId } });
  await prisma.client.user.delete({ where: { id: fixture.userId } });
}
