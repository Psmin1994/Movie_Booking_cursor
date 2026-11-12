/**
 * Test Intent:
 * 같은 PENDING Refund를 두 Worker가 동시에 Claim하면 하나만 성공한다.
 * Lease 만료 후에만 다른 Token으로 재Claim할 수 있다.
 * 만료된 Token의 settle은 NOT_HELD이며 새 Lease와 PENDING 상태를 바꾸지 않는다.
 * 새 Token으로는 COMPLETED 전이가 가능하고 Lease가 정리된다.
 */

import { randomInt, randomUUID } from "node:crypto";
import { jest } from "@jest/globals";
import { Prisma, PrismaClient } from "@movie-booking/database-prisma";
import { PrismaPg } from "@prisma/adapter-pg";
import { BOOKING_CANCELLED_STATUS } from "../src/booking/booking.constants.js";
import { PAYMENT_PAID_STATUS } from "../src/payment/payment.constants.js";
import {
  CLAIM_REFUND_RESULT,
  REFUND_CANCEL_REASON,
  REFUND_COMPLETED_STATUS,
  REFUND_LEASE_TTL_MS,
  REFUND_PENDING_STATUS,
  WORKER_SETTLE_REFUND_RESULT,
} from "../src/refund/refund.constants.js";
import { RefundRepository } from "../src/refund/repository/refund.repository.js";

jest.setTimeout(30_000);

const LOCK_WAIT_TIMEOUT_MS = 5_000;
const TRANSACTION_TIMEOUT_MS = 20_000;
const AMOUNT = 12_000;

type Tx = Prisma.TransactionClient;

type Fixture = {
  userId: string;
  movieId: string;
  screenId: string;
  screeningId: string;
  bookingId: string;
  paymentId: string;
  refundId: string;
};

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

async function createFixture(
  prisma: PrismaClient,
  input: {
    leaseToken?: string | null;
    leaseUntil?: Date | null;
    cancelRequestedAt?: Date | null;
    transactionKey?: string | null;
  } = {},
): Promise<Fixture> {
  const suffix = randomUUID();
  const user = await prisma.user.create({
    data: {
      email: `refund-lease-${suffix}@example.com`,
      passwordHash: "test-hash",
      name: "Refund Lease Test",
    },
  });
  const movie = await prisma.movie.create({
    data: {
      title: `refund-lease-${suffix}`,
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
      cancelledAt: new Date(),
    },
  });
  const payment = await prisma.payment.create({
    data: {
      bookingId: booking.id,
      orderId: `ord_${suffix}`,
      paymentKey: `pay_${suffix}`,
      status: PAYMENT_PAID_STATUS,
      amount: AMOUNT,
      paidAt: new Date(),
    },
  });
  const refund = await prisma.refund.create({
    data: {
      paymentId: payment.id,
      amount: AMOUNT,
      status: REFUND_PENDING_STATUS,
      idempotencyKey: randomUUID(),
      paymentKey: payment.paymentKey!,
      cancelReason: REFUND_CANCEL_REASON,
      cancelRequestedAt: input.cancelRequestedAt === undefined ? null : input.cancelRequestedAt,
      transactionKey: input.transactionKey === undefined ? null : input.transactionKey,
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
    refundId: refund.id,
  };
}

async function deleteFixture(prisma: PrismaClient, fixture: Fixture) {
  await prisma.refund.deleteMany({ where: { paymentId: fixture.paymentId } });
  await prisma.payment.deleteMany({ where: { bookingId: fixture.bookingId } });
  await prisma.booking.delete({ where: { id: fixture.bookingId } });
  await prisma.screening.delete({ where: { id: fixture.screeningId } });
  await prisma.screen.delete({ where: { id: fixture.screenId } });
  await prisma.movie.delete({ where: { id: fixture.movieId } });
  await prisma.user.delete({ where: { id: fixture.userId } });
}

async function readRefund(prisma: PrismaClient, refundId: string) {
  return prisma.refund.findUniqueOrThrow({
    where: { id: refundId },
    select: {
      status: true,
      completedAt: true,
      failedAt: true,
      transactionKey: true,
      leaseToken: true,
      leaseUntil: true,
    },
  });
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

describe("Refund claim and lease on PostgreSQL", () => {
  let prisma: PrismaClient;
  let repository: RefundRepository;

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error("DATABASE_URL is required for the PostgreSQL concurrency test.");
    }

    prisma = createClient(databaseUrl);
    await prisma.$connect();
    repository = new RefundRepository({} as never);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("lets only one concurrent claim succeed for the same refund", async () => {
    const now = new Date();
    const leaseUntil = new Date(now.getTime() + REFUND_LEASE_TTL_MS);
    const tokenA = randomUUID();
    const tokenB = randomUUID();
    const fixture = await createFixture(prisma);
    const lockAcquired = deferred<number>();
    const releaseHolder = deferred<void>();
    let waiterAcquired = false;

    try {
      const holder = prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`
            SELECT "id" FROM "Refund" WHERE "id" = ${fixture.refundId} FOR UPDATE
          `;
          lockAcquired.resolve(await readBackendPid(tx));
          await releaseHolder.promise;
          return repository.claimDue(tx, fixture.refundId, now, tokenA, leaseUntil);
        },
        { maxWait: TRANSACTION_TIMEOUT_MS, timeout: TRANSACTION_TIMEOUT_MS },
      );

      const holderPid = await lockAcquired.promise;
      const waiter = prisma.$transaction(
        async (tx) => {
          waiterAcquired = true;
          return repository.claimDue(tx, fixture.refundId, now, tokenB, leaseUntil);
        },
        { maxWait: TRANSACTION_TIMEOUT_MS, timeout: TRANSACTION_TIMEOUT_MS },
      );

      await waitUntilBlockedBy(prisma, holderPid);
      expect(waiterAcquired).toBe(true);
      releaseHolder.resolve();

      const [holderResult, waiterResult] = await Promise.all([holder, waiter]);
      const outcomes = [holderResult, waiterResult];
      const claimed = outcomes.find((result) => result.result === CLAIM_REFUND_RESULT.CLAIMED);
      const rejected = outcomes.find((result) => result.result === CLAIM_REFUND_RESULT.NOT_CLAIMED);

      expect(claimed?.result).toBe(CLAIM_REFUND_RESULT.CLAIMED);
      expect(rejected?.result).toBe(CLAIM_REFUND_RESULT.NOT_CLAIMED);
      if (claimed?.result !== CLAIM_REFUND_RESULT.CLAIMED) {
        throw new Error("expected exactly one successful claim");
      }

      const lease = await readRefund(prisma, fixture.refundId);
      expect(lease.status).toBe(REFUND_PENDING_STATUS);
      expect(lease.leaseToken).toBe(claimed.refund.leaseToken);
      expect(lease.leaseUntil).toEqual(claimed.refund.leaseUntil);
      expect([tokenA, tokenB]).toContain(lease.leaseToken);
      expect(lease.leaseToken === tokenA || lease.leaseToken === tokenB).toBe(true);
      expect(outcomes.filter((result) => result.result === CLAIM_REFUND_RESULT.CLAIMED)).toHaveLength(
        1,
      );
    } finally {
      releaseHolder.resolve();
      await deleteFixture(prisma, fixture);
    }
  });

  it("allows reclaim after lease expiry with a new token", async () => {
    const now = new Date();
    const expiredToken = randomUUID();
    const nextToken = randomUUID();
    const nextLeaseUntil = new Date(now.getTime() + REFUND_LEASE_TTL_MS);
    const fixture = await createFixture(prisma, {
      leaseToken: expiredToken,
      leaseUntil: new Date(now.getTime() - 1_000),
    });

    try {
      const claimed = await prisma.$transaction((tx) =>
        repository.claimDue(tx, fixture.refundId, now, nextToken, nextLeaseUntil),
      );

      expect(claimed.result).toBe(CLAIM_REFUND_RESULT.CLAIMED);
      if (claimed.result !== CLAIM_REFUND_RESULT.CLAIMED) {
        throw new Error("expected reclaim success");
      }
      expect(claimed.refund.leaseToken).toBe(nextToken);
      expect(claimed.refund.leaseToken).not.toBe(expiredToken);

      const lease = await readRefund(prisma, fixture.refundId);
      expect(lease.leaseToken).toBe(nextToken);
      expect(lease.leaseUntil).toEqual(nextLeaseUntil);
      expect(lease.status).toBe(REFUND_PENDING_STATUS);
    } finally {
      await deleteFixture(prisma, fixture);
    }
  });

  it("blocks a late complete from an expired previous lease holder", async () => {
    const now = new Date();
    const tokenA = randomUUID();
    const tokenB = randomUUID();
    const leaseUntilA = new Date(now.getTime() + REFUND_LEASE_TTL_MS);
    const leaseUntilB = new Date(now.getTime() + REFUND_LEASE_TTL_MS);
    const fixture = await createFixture(prisma, {
      cancelRequestedAt: new Date(now.getTime() - 60_000),
      transactionKey: `txn-${randomUUID()}`,
    });

    try {
      const claimedA = await prisma.$transaction((tx) =>
        repository.claimDue(tx, fixture.refundId, now, tokenA, leaseUntilA),
      );
      expect(claimedA.result).toBe(CLAIM_REFUND_RESULT.CLAIMED);

      await prisma.refund.update({
        where: { id: fixture.refundId },
        data: {
          leaseToken: tokenA,
          leaseUntil: new Date(now.getTime() - 1_000),
        },
      });

      const claimedB = await prisma.$transaction((tx) =>
        repository.claimDue(tx, fixture.refundId, now, tokenB, leaseUntilB),
      );
      expect(claimedB.result).toBe(CLAIM_REFUND_RESULT.CLAIMED);
      if (claimedB.result !== CLAIM_REFUND_RESULT.CLAIMED) {
        throw new Error("expected token B claim success");
      }

      const lateComplete = await prisma.$transaction((tx) =>
        repository.workerCompletePendingRefund(tx, fixture.refundId, tokenA, now),
      );
      expect(lateComplete).toEqual({ result: WORKER_SETTLE_REFUND_RESULT.NOT_HELD });

      const afterLate = await readRefund(prisma, fixture.refundId);
      expect(afterLate.status).toBe(REFUND_PENDING_STATUS);
      expect(afterLate.completedAt).toBeNull();
      expect(afterLate.leaseToken).toBe(tokenB);
      expect(afterLate.leaseUntil).toEqual(leaseUntilB);
    } finally {
      await deleteFixture(prisma, fixture);
    }
  });

  it("completes with the new lease holder after the previous holder is blocked", async () => {
    const now = new Date();
    const tokenA = randomUUID();
    const tokenB = randomUUID();
    const leaseUntilA = new Date(now.getTime() + REFUND_LEASE_TTL_MS);
    const leaseUntilB = new Date(now.getTime() + REFUND_LEASE_TTL_MS);
    const transactionKey = `txn-${randomUUID()}`;
    const fixture = await createFixture(prisma, {
      cancelRequestedAt: new Date(now.getTime() - 60_000),
      transactionKey,
    });

    try {
      await prisma.$transaction((tx) =>
        repository.claimDue(tx, fixture.refundId, now, tokenA, leaseUntilA),
      );

      await prisma.refund.update({
        where: { id: fixture.refundId },
        data: {
          leaseToken: tokenA,
          leaseUntil: new Date(now.getTime() - 1_000),
        },
      });

      const claimedB = await prisma.$transaction((tx) =>
        repository.claimDue(tx, fixture.refundId, now, tokenB, leaseUntilB),
      );
      expect(claimedB.result).toBe(CLAIM_REFUND_RESULT.CLAIMED);

      const lateComplete = await prisma.$transaction((tx) =>
        repository.workerCompletePendingRefund(tx, fixture.refundId, tokenA, now),
      );
      expect(lateComplete.result).toBe(WORKER_SETTLE_REFUND_RESULT.NOT_HELD);

      const completed = await prisma.$transaction((tx) =>
        repository.workerCompletePendingRefund(tx, fixture.refundId, tokenB, now),
      );
      expect(completed.result).toBe(WORKER_SETTLE_REFUND_RESULT.COMPLETED);
      if (completed.result !== WORKER_SETTLE_REFUND_RESULT.COMPLETED) {
        throw new Error("expected token B complete success");
      }
      expect(completed.refund.status).toBe(REFUND_COMPLETED_STATUS);
      expect(completed.refund.completedAt).toEqual(now);

      const after = await readRefund(prisma, fixture.refundId);
      expect(after.status).toBe(REFUND_COMPLETED_STATUS);
      expect(after.completedAt).toEqual(now);
      expect(after.leaseToken).toBeNull();
      expect(after.leaseUntil).toBeNull();
      expect(after.transactionKey).toBe(transactionKey);
    } finally {
      await deleteFixture(prisma, fixture);
    }
  });
});
