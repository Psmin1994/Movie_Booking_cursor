/**
 * Test Intent:
 * 동일 Reconciliation에 대한 동시 PAID 완료는 Lease fencing으로 하나만 성공한다.
 * Lease 만료 후 이전 Token의 늦은 completeAsRefundCreated는 NOT_HELD이며 Payment·Refund를 남기지 않는다.
 * 이전 Worker는 새 Worker의 Lease를 해제하거나 덮어쓰지 못한다.
 * Payment당 Refund unique 제약은 유지된다.
 */

import { randomInt, randomUUID } from "node:crypto";
import { jest } from "@jest/globals";
import { Prisma, PrismaClient } from "@movie-booking/database-prisma";
import { PrismaPg } from "@prisma/adapter-pg";
import { BOOKING_CANCELLED_STATUS } from "../src/booking/booking.constants.js";
import {
  COMPLETE_RECONCILIATION_AS_REFUND_CREATED_RESULT,
  PAY_RECONCILIATION_PAYMENT_RESULT,
  PAYMENT_PAID_STATUS,
  PAYMENT_RECONCILIATION_REQUIRED_STATUS,
  RECONCILIATION_COMPLETED_STATUS,
  RECONCILIATION_LEASE_TTL_MS,
  RECONCILIATION_RESULT_REFUND_CREATED,
  RECONCILIATION_SCHEDULED_STATUS,
  RELEASE_RECONCILIATION_LEASE_RESULT,
} from "../src/payment/payment.constants.js";
import { PaymentRepository } from "../src/payment/repository/payment.repository.js";
import { ReconcilePaymentRepository } from "../src/payment/repository/reconcile-payment.repository.js";
import { REFUND_PENDING_STATUS } from "../src/refund/refund.constants.js";
import { RefundRepository } from "../src/refund/repository/refund.repository.js";

jest.setTimeout(30_000);

const AMOUNT = 9_000;
const LOCK_WAIT_TIMEOUT_MS = 5_000;
const TRANSACTION_TIMEOUT_MS = 20_000;

type Tx = Prisma.TransactionClient;

type Fixture = {
  userId: string;
  movieId: string;
  screenId: string;
  screeningId: string;
  bookingId: string;
  paymentId: string;
  reconciliationId: string;
};

class PaidCompletionAbortError extends Error {
  readonly outcome: "NOT_HELD";

  constructor() {
    super("PAID completion aborted");
    this.name = "PaidCompletionAbortError";
    this.outcome = "NOT_HELD";
  }
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function sleep(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function createClient(databaseUrl: string) {
  const adapter = new PrismaPg({ connectionString: databaseUrl, max: 5 });
  return new PrismaClient({ adapter });
}

describe("ReconcilePayment PAID completion concurrency on PostgreSQL", () => {
  let prisma: PrismaClient;
  let reconcilePaymentRepository: ReconcilePaymentRepository;
  let paymentRepository: PaymentRepository;
  let refundRepository: RefundRepository;

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error("DATABASE_URL is required for the PostgreSQL concurrency test.");
    }

    prisma = createClient(databaseUrl);
    await prisma.$connect();
    reconcilePaymentRepository = new ReconcilePaymentRepository({} as never);
    paymentRepository = new PaymentRepository({} as never);
    refundRepository = new RefundRepository({} as never);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("lets only one concurrent PAID completion succeed under lease fencing", async () => {
    const now = new Date();
    const leaseToken = randomUUID();
    const fixture = await createFixture(prisma, {
      leaseToken,
      leaseUntil: new Date(now.getTime() + RECONCILIATION_LEASE_TTL_MS),
    });
    const lockAcquired = deferred<number>();
    const releaseHolder = deferred<void>();

    try {
      const first = runPaidCompletion(prisma, async (tx) => {
        await tx.$queryRaw`
          SELECT "id" FROM "Payment" WHERE "id" = ${fixture.paymentId} FOR UPDATE
        `;
        lockAcquired.resolve(await readBackendPid(tx));
        await releaseHolder.promise;
        return applyPaidCompletion(tx, fixture, leaseToken, now);
      });

      const holderPid = await lockAcquired.promise;

      const second = runPaidCompletion(prisma, async (tx) =>
        applyPaidCompletion(tx, fixture, leaseToken, now),
      );

      await waitUntilBlockedBy(prisma, holderPid);
      releaseHolder.resolve();

      const [firstResult, secondResult] = await Promise.all([first, second]);
      expect([firstResult, secondResult].sort()).toEqual(["COMPLETED", "NOT_HELD"]);

      const payment = await prisma.payment.findUniqueOrThrow({
        where: { id: fixture.paymentId },
        select: { status: true },
      });
      const refunds = await prisma.refund.findMany({
        where: { paymentId: fixture.paymentId },
        select: { id: true, status: true },
      });
      const reconciliation = await prisma.paymentReconciliation.findUniqueOrThrow({
        where: { id: fixture.reconciliationId },
        select: { status: true, result: true, leaseToken: true },
      });

      expect(payment.status).toBe(PAYMENT_PAID_STATUS);
      expect(refunds).toEqual([{ id: expect.any(String), status: REFUND_PENDING_STATUS }]);
      expect(reconciliation).toEqual({
        status: RECONCILIATION_COMPLETED_STATUS,
        result: RECONCILIATION_RESULT_REFUND_CREATED,
        leaseToken: null,
      });
    } finally {
      releaseHolder.resolve();
      await deleteFixture(prisma, fixture);
    }
  });

  it("blocks a late PAID completion after the lease expires", async () => {
    const now = new Date();
    const oldToken = randomUUID();
    const fixture = await createFixture(prisma, {
      leaseToken: oldToken,
      leaseUntil: new Date(now.getTime() - 1_000),
    });

    await expect(
      runPaidCompletion(prisma, async (tx) =>
        applyPaidCompletion(tx, fixture, oldToken, now),
      ),
    ).resolves.toBe("NOT_HELD");

    const payment = await prisma.payment.findUniqueOrThrow({
      where: { id: fixture.paymentId },
      select: { status: true, paidAt: true },
    });
    const refund = await prisma.refund.findUnique({
      where: { paymentId: fixture.paymentId },
      select: { id: true },
    });
    const reconciliation = await prisma.paymentReconciliation.findUniqueOrThrow({
      where: { id: fixture.reconciliationId },
      select: {
        status: true,
        result: true,
        leaseToken: true,
      },
    });

    expect(payment).toEqual({
      status: PAYMENT_RECONCILIATION_REQUIRED_STATUS,
      paidAt: null,
    });
    expect(refund).toBeNull();
    expect(reconciliation.status).toBe(RECONCILIATION_SCHEDULED_STATUS);
    expect(reconciliation.result).toBeNull();
    expect(reconciliation.leaseToken).toBe(oldToken);

    await deleteFixture(prisma, fixture);
  });

  it("prevents a previous worker from releasing a newer lease", async () => {
    const now = new Date();
    const oldToken = randomUUID();
    const newToken = randomUUID();
    const fixture = await createFixture(prisma, {
      leaseToken: newToken,
      leaseUntil: new Date(now.getTime() + RECONCILIATION_LEASE_TTL_MS),
    });

    await expect(
      prisma.$transaction((tx) =>
        reconcilePaymentRepository.releaseLease(tx, fixture.reconciliationId, oldToken, now),
      ),
    ).resolves.toEqual({
      result: RELEASE_RECONCILIATION_LEASE_RESULT.NOT_HELD,
    });

    const reconciliation = await prisma.paymentReconciliation.findUniqueOrThrow({
      where: { id: fixture.reconciliationId },
      select: { leaseToken: true },
    });
    expect(reconciliation.leaseToken).toBe(newToken);

    await deleteFixture(prisma, fixture);
  });

  it("rejects a second pending refund for the same payment under the unique constraint", async () => {
    const now = new Date();
    const leaseToken = randomUUID();
    const fixture = await createFixture(prisma, {
      leaseToken,
      leaseUntil: new Date(now.getTime() + RECONCILIATION_LEASE_TTL_MS),
    });

    await prisma.$transaction(async (tx) => {
      const paid = await paymentRepository.payReconciliationPayment(tx, fixture.paymentId, now);
      expect(paid.result).toBe(PAY_RECONCILIATION_PAYMENT_RESULT.PAID);
      await refundRepository.createPendingRefund(tx, fixture.paymentId, AMOUNT);
    });

    await expect(
      prisma.$transaction((tx) =>
        refundRepository.createPendingRefund(tx, fixture.paymentId, AMOUNT),
      ),
    ).rejects.toMatchObject({ code: "P2002" });

    const refunds = await prisma.refund.findMany({
      where: { paymentId: fixture.paymentId },
      select: { id: true },
    });
    expect(refunds).toHaveLength(1);

    await deleteFixture(prisma, fixture);
  });
});

async function runPaidCompletion(
  prisma: PrismaClient,
  work: (tx: Tx) => Promise<"COMPLETED">,
): Promise<"COMPLETED" | "NOT_HELD"> {
  try {
    return await prisma.$transaction(work, {
      maxWait: TRANSACTION_TIMEOUT_MS,
      timeout: TRANSACTION_TIMEOUT_MS,
    });
  } catch (error) {
    if (
      error instanceof PaidCompletionAbortError ||
      (typeof error === "object" &&
        error !== null &&
        "outcome" in error &&
        (error as { outcome: unknown }).outcome === "NOT_HELD")
    ) {
      return "NOT_HELD";
    }
    throw error;
  }
}

async function applyPaidCompletion(
  tx: Tx,
  fixture: Fixture,
  leaseToken: string,
  now: Date,
): Promise<"COMPLETED"> {
  const paymentRepository = new PaymentRepository({} as never);
  const refundRepository = new RefundRepository({} as never);
  const reconcilePaymentRepository = new ReconcilePaymentRepository({} as never);

  const existingRefund = await refundRepository.findByPaymentId(tx, fixture.paymentId);
  if (existingRefund) {
    throw new PaidCompletionAbortError();
  }

  const paid = await paymentRepository.payReconciliationPayment(tx, fixture.paymentId, now);
  if (paid.result !== PAY_RECONCILIATION_PAYMENT_RESULT.PAID) {
    throw new PaidCompletionAbortError();
  }

  await refundRepository.createPendingRefund(tx, fixture.paymentId, AMOUNT);

  const completed = await reconcilePaymentRepository.completeAsRefundCreated(
    tx,
    fixture.reconciliationId,
    leaseToken,
    now,
  );

  if (completed.result === COMPLETE_RECONCILIATION_AS_REFUND_CREATED_RESULT.COMPLETED) {
    return "COMPLETED";
  }

  throw new PaidCompletionAbortError();
}

async function createFixture(
  prisma: PrismaClient,
  input: {
    leaseToken: string;
    leaseUntil: Date;
  },
): Promise<Fixture> {
  const suffix = randomUUID();
  const user = await prisma.user.create({
    data: {
      email: `reconcile-paid-concurrency-${suffix}@example.com`,
      passwordHash: "test-hash",
      name: "Reconcile Paid Concurrency",
    },
  });
  const movie = await prisma.movie.create({
    data: {
      title: `reconcile-paid-concurrency-${suffix}`,
      runtime: 100,
      releaseDate: new Date("2026-01-01"),
    },
  });
  const screen = await prisma.screen.create({
    data: {
      number: randomInt(1_000_000, 2_000_000_000),
      floor: 1,
      screenType: "TEST",
    },
  });
  const screening = await prisma.screening.create({
    data: {
      movieId: movie.id,
      screenId: screen.id,
      startAt: new Date("2099-01-01T00:00:00.000Z"),
    },
  });
  const booking = await prisma.booking.create({
    data: {
      userId: user.id,
      screeningId: screening.id,
      status: BOOKING_CANCELLED_STATUS,
      totalAmount: AMOUNT,
      expiresAt: new Date(Date.now() + 60_000),
      cancelledAt: new Date("2026-10-31T11:00:00.000Z"),
    },
  });
  const payment = await prisma.payment.create({
    data: {
      bookingId: booking.id,
      orderId: `ord_${suffix}`,
      paymentKey: `pay_${suffix}`,
      status: PAYMENT_RECONCILIATION_REQUIRED_STATUS,
      amount: AMOUNT,
    },
  });
  const openedAt = new Date("2026-10-31T11:00:00.000Z");
  const reconciliation = await prisma.paymentReconciliation.create({
    data: {
      paymentId: payment.id,
      status: RECONCILIATION_SCHEDULED_STATUS,
      createdAt: openedAt,
      nextProcessAt: openedAt,
      retryDeadline: new Date(openedAt.getTime() + 10 * 60_000),
      leaseToken: input.leaseToken,
      leaseUntil: input.leaseUntil,
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

async function deleteFixture(prisma: PrismaClient, fixture: Fixture) {
  await prisma.refund.deleteMany({ where: { paymentId: fixture.paymentId } });
  await prisma.paymentReconciliation.deleteMany({ where: { paymentId: fixture.paymentId } });
  await prisma.payment.deleteMany({ where: { bookingId: fixture.bookingId } });
  await prisma.booking.delete({ where: { id: fixture.bookingId } });
  await prisma.screening.delete({ where: { id: fixture.screeningId } });
  await prisma.screen.delete({ where: { id: fixture.screenId } });
  await prisma.movie.delete({ where: { id: fixture.movieId } });
  await prisma.user.delete({ where: { id: fixture.userId } });
}

async function readBackendPid(tx: Tx): Promise<number> {
  const rows = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`;
  const pid = Number(rows[0]?.pid);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error("Could not read the holder backend pid.");
  }
  return pid;
}

async function waitUntilBlockedBy(prisma: PrismaClient, holderPid: number): Promise<void> {
  const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const rows = await prisma.$queryRaw<Array<{ waiting: number }>>`
      SELECT COUNT(*)::int AS waiting
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
        AND ${holderPid}::int = ANY (pg_blocking_pids(pid))
    `;
    if (Number(rows[0]?.waiting ?? 0) > 0) {
      return;
    }
    await sleep(25);
  }

  throw new Error(`Timed out waiting for a transaction blocked by backend ${holderPid}.`);
}
