/**
 * Test Intent:
 * ProcessRefundScheduler가 findDueRefundIds로 고른 PENDING Refund를 실제 ProcessRefundService로 처리한다.
 * Gateway Cancel/Retrieve 결과에 따라 COMPLETED·FAILED·PENDING이 되고, transactionKey가 있으면 Cancel 없이 Retrieve만 한다.
 * 유효 Lease를 가진 Refund는 due 대상이 아니며, Claim 실패(NOT_CLAIMED)는 예외가 아니다.
 */

import { randomInt, randomUUID } from "node:crypto";
import { jest } from "@jest/globals";
import { INestApplication, Logger } from "@nestjs/common";
import { App } from "supertest/types";
import { BOOKING_CANCELLED_STATUS } from "../src/booking/booking.constants.js";
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
} from "../src/payment/gateway/payment-gateway.js";
import { PAYMENT_PAID_STATUS } from "../src/payment/payment.constants.js";
import {
  PROCESS_REFUND_RESULT,
  PROCESS_REFUND_SCHEDULER_BATCH_LIMIT,
  REFUND_CANCEL_REASON,
  REFUND_COMPLETED_STATUS,
  REFUND_FAILED_STATUS,
  REFUND_LEASE_TTL_MS,
  REFUND_PENDING_STATUS,
} from "../src/refund/refund.constants.js";
import { RefundRepository } from "../src/refund/repository/refund.repository.js";
import { ProcessRefundScheduler } from "../src/refund/scheduler/process-refund.scheduler.js";
import { ProcessRefundService } from "../src/refund/use-case/process-refund.service.js";
import { createTestApp } from "./helpers/create-test-app.js";

jest.setTimeout(30_000);

const AMOUNT = 15_000;

type Fixture = {
  userId: string;
  movieId: string;
  screenId: string;
  screeningId: string;
  bookingId: string;
  paymentId: string;
  refundId: string;
  paymentKey: string;
  idempotencyKey: string;
};

class ScriptablePaymentGateway extends PaymentGateway {
  cancelResult: "SUCCESS" | "FAILED" | "UNKNOWN" = "SUCCESS";
  retrieveCancelResult: "CANCELED" | "NOT_CANCELED" | "UNKNOWN" = "CANCELED";
  cancelCalls: PaymentGatewayCancelInput[] = [];
  retrieveCancelCalls: PaymentGatewayRetrieveCancelOutcomeInput[] = [];

  confirm(
    input: PaymentGatewayConfirmInput,
  ): Promise<PaymentGatewayConfirmResult> {
    return Promise.resolve({
      status: "SUCCESS",
      paymentKey: input.paymentKey,
      orderId: input.orderId,
      amount: input.amount,
      approvedAt: new Date(),
    });
  }

  retrieve(_input: PaymentGatewayRetrieveInput): Promise<PaymentGatewayConfirmResult> {
    return Promise.resolve({ status: "UNKNOWN" });
  }

  cancel(input: PaymentGatewayCancelInput): Promise<PaymentGatewayCancelResult> {
    this.cancelCalls.push(input);

    if (this.cancelResult === "FAILED") {
      return Promise.resolve({ status: "FAILED" });
    }

    if (this.cancelResult === "UNKNOWN") {
      return Promise.resolve({ status: "UNKNOWN" });
    }

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
    this.retrieveCancelCalls.push(input);

    if (this.retrieveCancelResult === "NOT_CANCELED") {
      return Promise.resolve({ status: "NOT_CANCELED" });
    }

    if (this.retrieveCancelResult === "UNKNOWN") {
      return Promise.resolve({ status: "UNKNOWN" });
    }

    return Promise.resolve({
      status: "CANCELED",
      paymentKey: input.paymentKey,
      transactionKey: input.transactionKey,
      cancelAmount: input.cancelAmount,
    });
  }

  reset() {
    this.cancelResult = "SUCCESS";
    this.retrieveCancelResult = "CANCELED";
    this.cancelCalls = [];
    this.retrieveCancelCalls = [];
  }
}

describe("ProcessRefundWorker integration on PostgreSQL", () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let refundRepository: RefundRepository;
  let scheduler: ProcessRefundScheduler;
  let processRefundService: ProcessRefundService;
  const paymentGateway = new ScriptablePaymentGateway();
  let loggerError: jest.SpiedFunction<Logger["error"]>;

  beforeAll(async () => {
    app = await createTestApp((builder) =>
      builder.overrideProvider(PaymentGateway).useValue(paymentGateway),
    );
    prisma = app.get(PrismaService);
    refundRepository = app.get(RefundRepository);
    scheduler = app.get(ProcessRefundScheduler);
    processRefundService = app.get(ProcessRefundService);
  });

  beforeEach(() => {
    paymentGateway.reset();
    loggerError = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    loggerError.mockRestore();
  });

  afterAll(async () => {
    await app.close();
  });

  it("runs scheduler through worker to COMPLETED", async () => {
    const fixture = await createPendingRefundFixture(prisma);

    try {
      await expectOnlyDueRefund(refundRepository, fixture.refundId);
      await scheduler.processDueRefunds();

      const cancelCalls = paymentGateway.cancelCalls.filter(
        (call) => call.idempotencyKey === fixture.idempotencyKey,
      );
      const retrieveCalls = paymentGateway.retrieveCancelCalls.filter(
        (call) => call.paymentKey === fixture.paymentKey,
      );
      expect(cancelCalls).toEqual([
        expect.objectContaining({
          paymentKey: fixture.paymentKey,
          cancelAmount: AMOUNT,
          idempotencyKey: fixture.idempotencyKey,
        }),
      ]);
      expect(retrieveCalls).toEqual([
        expect.objectContaining({
          transactionKey: `txn-${fixture.idempotencyKey}`,
        }),
      ]);

      const refund = await readRefund(prisma, fixture.refundId);
      expect(refund.status).toBe(REFUND_COMPLETED_STATUS);
      expect(refund.completedAt).toBeInstanceOf(Date);
      expect(refund.failedAt).toBeNull();
      expect(refund.transactionKey).toBe(`txn-${fixture.idempotencyKey}`);
      expect(refund.leaseToken).toBeNull();
      expect(refund.leaseUntil).toBeNull();
      expect(loggerError).not.toHaveBeenCalled();
    } finally {
      await deleteFixture(prisma, fixture);
    }
  });

  it("marks FAILED when cancel fails and does not retrieve", async () => {
    paymentGateway.cancelResult = "FAILED";
    const fixture = await createPendingRefundFixture(prisma);

    try {
      await expectOnlyDueRefund(refundRepository, fixture.refundId);
      await scheduler.processDueRefunds();

      expect(
        paymentGateway.cancelCalls.filter(
          (call) => call.idempotencyKey === fixture.idempotencyKey,
        ),
      ).toHaveLength(1);
      expect(
        paymentGateway.retrieveCancelCalls.filter(
          (call) => call.paymentKey === fixture.paymentKey,
        ),
      ).toHaveLength(0);

      const refund = await readRefund(prisma, fixture.refundId);
      expect(refund.status).toBe(REFUND_FAILED_STATUS);
      expect(refund.failedAt).toBeInstanceOf(Date);
      expect(refund.completedAt).toBeNull();
      expect(refund.transactionKey).toBeNull();
      expect(refund.leaseToken).toBeNull();
      expect(refund.leaseUntil).toBeNull();
      expect(loggerError).not.toHaveBeenCalled();
    } finally {
      await deleteFixture(prisma, fixture);
    }
  });

  it("keeps PENDING and releases the lease when cancel is UNKNOWN", async () => {
    paymentGateway.cancelResult = "UNKNOWN";
    const fixture = await createPendingRefundFixture(prisma);

    try {
      await expectOnlyDueRefund(refundRepository, fixture.refundId);
      await scheduler.processDueRefunds();

      expect(
        paymentGateway.cancelCalls.filter(
          (call) => call.idempotencyKey === fixture.idempotencyKey,
        ),
      ).toHaveLength(1);
      expect(
        paymentGateway.retrieveCancelCalls.filter(
          (call) => call.paymentKey === fixture.paymentKey,
        ),
      ).toHaveLength(0);

      const refund = await readRefund(prisma, fixture.refundId);
      expect(refund.status).toBe(REFUND_PENDING_STATUS);
      expect(refund.completedAt).toBeNull();
      expect(refund.failedAt).toBeNull();
      expect(refund.transactionKey).toBeNull();
      expect(refund.cancelRequestedAt).toBeInstanceOf(Date);
      expect(refund.leaseToken).toBeNull();
      expect(refund.leaseUntil).toBeNull();

      paymentGateway.reset();
      await expectOnlyDueRefund(refundRepository, fixture.refundId);
      await scheduler.processDueRefunds();

      const afterRetry = await readRefund(prisma, fixture.refundId);
      expect(afterRetry.status).toBe(REFUND_COMPLETED_STATUS);
      expect(
        paymentGateway.cancelCalls.filter(
          (call) => call.idempotencyKey === fixture.idempotencyKey,
        ),
      ).toHaveLength(1);
      expect(
        paymentGateway.retrieveCancelCalls.filter(
          (call) => call.paymentKey === fixture.paymentKey,
        ),
      ).toHaveLength(1);
      expect(loggerError).not.toHaveBeenCalled();
    } finally {
      await deleteFixture(prisma, fixture);
    }
  });

  it("skips Cancel and completes from Retrieve when transactionKey already exists", async () => {
    const transactionKey = `txn-existing-${randomUUID()}`;
    const fixture = await createPendingRefundFixture(prisma, {
      cancelRequestedAt: new Date("2026-10-20T00:00:00.000Z"),
      transactionKey,
    });

    try {
      await expectOnlyDueRefund(refundRepository, fixture.refundId);
      await scheduler.processDueRefunds();

      expect(
        paymentGateway.cancelCalls.filter(
          (call) => call.idempotencyKey === fixture.idempotencyKey,
        ),
      ).toHaveLength(0);
      expect(
        paymentGateway.retrieveCancelCalls.filter(
          (call) => call.paymentKey === fixture.paymentKey,
        ),
      ).toEqual([
        expect.objectContaining({
          paymentKey: fixture.paymentKey,
          transactionKey,
          cancelAmount: AMOUNT,
        }),
      ]);

      const refund = await readRefund(prisma, fixture.refundId);
      expect(refund.status).toBe(REFUND_COMPLETED_STATUS);
      expect(refund.transactionKey).toBe(transactionKey);
      expect(refund.leaseToken).toBeNull();
      expect(refund.leaseUntil).toBeNull();
      expect(loggerError).not.toHaveBeenCalled();
    } finally {
      await deleteFixture(prisma, fixture);
    }
  });

  it("does not process a refund held by another lease and treats NOT_CLAIMED as non-error", async () => {
    const holderToken = randomUUID();
    const now = new Date();
    const fixture = await createPendingRefundFixture(prisma, {
      leaseToken: holderToken,
      leaseUntil: new Date(now.getTime() + REFUND_LEASE_TTL_MS),
    });

    try {
      const dueIds = await refundRepository.findDueRefundIds(
        new Date(Date.now()),
        PROCESS_REFUND_SCHEDULER_BATCH_LIMIT,
      );
      expect(dueIds).not.toContain(fixture.refundId);

      await scheduler.processDueRefunds();

      expect(
        paymentGateway.cancelCalls.filter(
          (call) => call.idempotencyKey === fixture.idempotencyKey,
        ),
      ).toHaveLength(0);
      expect(
        paymentGateway.retrieveCancelCalls.filter(
          (call) => call.paymentKey === fixture.paymentKey,
        ),
      ).toHaveLength(0);

      const afterScheduler = await readRefund(prisma, fixture.refundId);
      expect(afterScheduler.status).toBe(REFUND_PENDING_STATUS);
      expect(afterScheduler.leaseToken).toBe(holderToken);
      expect(afterScheduler.transactionKey).toBeNull();
      expect(loggerError).not.toHaveBeenCalled();

      await expect(processRefundService.execute(fixture.refundId)).resolves.toEqual({
        result: PROCESS_REFUND_RESULT.NOT_CLAIMED,
      });

      const afterExecute = await readRefund(prisma, fixture.refundId);
      expect(afterExecute.status).toBe(REFUND_PENDING_STATUS);
      expect(afterExecute.leaseToken).toBe(holderToken);
      expect(
        paymentGateway.cancelCalls.filter(
          (call) => call.idempotencyKey === fixture.idempotencyKey,
        ),
      ).toHaveLength(0);
      expect(
        paymentGateway.retrieveCancelCalls.filter(
          (call) => call.paymentKey === fixture.paymentKey,
        ),
      ).toHaveLength(0);
      expect(loggerError).not.toHaveBeenCalled();
    } finally {
      await deleteFixture(prisma, fixture);
    }
  });
});

async function createPendingRefundFixture(
  prisma: PrismaService,
  overrides: {
    leaseToken?: string | null;
    leaseUntil?: Date | null;
    cancelRequestedAt?: Date | null;
    transactionKey?: string | null;
  } = {},
): Promise<Fixture> {
  const suffix = randomUUID();
  const idempotencyKey = randomUUID();
  const paymentKey = `pay_${suffix}`;

  const user = await prisma.client.user.create({
    data: {
      email: `refund-worker-${suffix}@example.com`,
      passwordHash: "test-hash",
      name: "Refund Worker Test",
    },
  });
  const movie = await prisma.client.movie.create({
    data: {
      title: `refund-worker-${suffix}`,
      runtime: 110,
      releaseDate: new Date("2026-01-01"),
    },
  });
  const screen = await prisma.client.screen.create({
    data: {
      number: randomInt(1_000_000, 2_000_000_000),
      floor: 2,
      screenType: "TEST",
    },
  });
  const screening = await prisma.client.screening.create({
    data: {
      movieId: movie.id,
      screenId: screen.id,
      startAt: new Date("2099-02-01T00:00:00.000Z"),
    },
  });
  const booking = await prisma.client.booking.create({
    data: {
      userId: user.id,
      screeningId: screening.id,
      status: BOOKING_CANCELLED_STATUS,
      totalAmount: AMOUNT,
      expiresAt: new Date(Date.now() + 60_000),
      cancelledAt: new Date(),
    },
  });
  const payment = await prisma.client.payment.create({
    data: {
      bookingId: booking.id,
      orderId: `ord_${suffix}`,
      paymentKey,
      status: PAYMENT_PAID_STATUS,
      amount: AMOUNT,
      paidAt: new Date(),
    },
  });
  const refund = await prisma.client.refund.create({
    data: {
      paymentId: payment.id,
      amount: AMOUNT,
      status: REFUND_PENDING_STATUS,
      idempotencyKey,
      paymentKey,
      cancelReason: REFUND_CANCEL_REASON,
      cancelRequestedAt:
        overrides.cancelRequestedAt === undefined ? null : overrides.cancelRequestedAt,
      transactionKey: overrides.transactionKey === undefined ? null : overrides.transactionKey,
      leaseToken: overrides.leaseToken === undefined ? null : overrides.leaseToken,
      leaseUntil: overrides.leaseUntil === undefined ? null : overrides.leaseUntil,
    },
  });

  return {
    userId: user.id,
    movieId: movie.id,
    screenId: screen.id,
    screeningId: screening.id,
    bookingId: booking.id,
    paymentId: payment.id,
    refundId: refund.id,
    paymentKey,
    idempotencyKey,
  };
}

async function deleteFixture(prisma: PrismaService, fixture: Fixture) {
  await prisma.client.refund.deleteMany({ where: { paymentId: fixture.paymentId } });
  await prisma.client.payment.deleteMany({ where: { bookingId: fixture.bookingId } });
  await prisma.client.booking.delete({ where: { id: fixture.bookingId } });
  await prisma.client.screening.delete({ where: { id: fixture.screeningId } });
  await prisma.client.screen.delete({ where: { id: fixture.screenId } });
  await prisma.client.movie.delete({ where: { id: fixture.movieId } });
  await prisma.client.user.delete({ where: { id: fixture.userId } });
}

async function readRefund(prisma: PrismaService, refundId: string) {
  return prisma.client.refund.findUniqueOrThrow({
    where: { id: refundId },
    select: {
      status: true,
      completedAt: true,
      failedAt: true,
      transactionKey: true,
      cancelRequestedAt: true,
      leaseToken: true,
      leaseUntil: true,
    },
  });
}

async function expectOnlyDueRefund(refundRepository: RefundRepository, refundId: string) {
  const dueIds = await refundRepository.findDueRefundIds(
    new Date(Date.now()),
    PROCESS_REFUND_SCHEDULER_BATCH_LIMIT,
  );
  const foreign = dueIds.filter((id) => id !== refundId);
  if (foreign.length > 0) {
    throw new Error(
      `Unexpected due refunds in shared test DB: ${foreign.join(", ")}. Clean leftover PENDING refunds before running this suite.`,
    );
  }
  expect(dueIds).toEqual([refundId]);
}
