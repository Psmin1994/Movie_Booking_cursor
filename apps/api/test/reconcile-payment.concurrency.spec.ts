/**
 * Test Intent:
 * 같은 PaymentReconciliation을 두 워커가 동시에 Claim하면 하나만 성공한다. Lease 만료 후에만 재Claim이 가능하고, 재Claim 토큰으로만 해제가 된다. nextProcessAt이 미래이거나 status가 SCHEDULED가 아니거나 Lease가 반쪽이거나 retryDeadline이 지나거나 도래한 행은 Claim되지 않는다.
 * retryDeadline이 만료되고 유효 Lease가 없으면 REVIEW·UNRESOLVED로 전환되고 만료 Lease 필드는 해제된다. 활성 Lease가 있으면 REVIEW로 바꾸지 않으며, 그 Worker는 nextProcessAt만 재예약하고 result는 유지한다. Lease가 만료된 뒤에만 REVIEW 전환이 가능하고 이후 Claim은 실패한다. Claim과 REVIEW는 같은 기준 시각에서 deadline 조건이 상호 배타적이며, 행 잠금 대기 후 WHERE가 재평가된다.
 */

import { randomInt, randomUUID } from "node:crypto";
import { jest } from "@jest/globals";
import { Prisma, PrismaClient } from "@movie-booking/database-prisma";
import { PrismaPg } from "@prisma/adapter-pg";
import { BOOKING_CANCELLED_STATUS } from "../src/booking/booking.constants.js";
import {
  CLAIM_RECONCILIATION_RESULT,
  MARK_RECONCILIATION_REVIEW_PAST_DEADLINE_RESULT,
  PAYMENT_RECONCILIATION_REQUIRED_STATUS,
  RECONCILIATION_COMPLETED_STATUS,
  RECONCILIATION_RESULT_UNRESOLVED,
  RECONCILIATION_LEASE_TTL_MS,
  RECONCILIATION_REVIEW_STATUS,
  RECONCILIATION_SCHEDULED_STATUS,
  RELEASE_RECONCILIATION_LEASE_RESULT,
  RESCHEDULE_RECONCILIATION_AFTER_UNKNOWN_RESULT,
} from "../src/payment/payment.constants.js";
import { AUTOMATIC_RETRIEVE_INTERVAL_MS } from "../src/payment/reconciliation-schedule.js";
import { ReconcilePaymentRepository } from "../src/payment/repository/reconcile-payment.repository.js";

jest.setTimeout(30_000);

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
    status: string;
    nextProcessAt: Date | null;
    retryDeadline?: Date;
    result?: string | null;
    leaseToken?: string | null;
    leaseUntil?: Date | null;
    completedAt?: Date | null;
  },
): Promise<Fixture> {
  const suffix = randomUUID();
  const user = await prisma.user.create({
    data: {
      email: `reconciliation-lease-${suffix}@example.com`,
      passwordHash: "test-hash",
      name: "Reconciliation Lease Test",
    },
  });
  const movie = await prisma.movie.create({
    data: {
      title: `reconciliation-lease-${suffix}`,
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
      totalAmount: 1000,
      expiresAt: new Date(Date.now() + 60_000),
      cancelledAt: new Date("2026-10-14T00:00:00.000Z"),
    },
  });
  const payment = await prisma.payment.create({
    data: {
      bookingId: booking.id,
      orderId: `ord_${suffix}`,
      paymentKey: `pay_${suffix}`,
      status: PAYMENT_RECONCILIATION_REQUIRED_STATUS,
      amount: 1000,
    },
  });
  const createdAt = new Date("2026-10-14T00:00:00.000Z");
  const reconciliation = await prisma.paymentReconciliation.create({
    data: {
      paymentId: payment.id,
      status: input.status,
      createdAt,
      nextProcessAt: input.nextProcessAt,
      retryDeadline: input.retryDeadline ?? new Date(Date.now() + 10 * 60_000),
      result: input.result === undefined ? null : input.result,
      completedAt: input.completedAt ?? null,
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

async function deleteFixture(prisma: PrismaClient, fixture: Fixture) {
  await prisma.paymentReconciliation.deleteMany({ where: { paymentId: fixture.paymentId } });
  await prisma.payment.deleteMany({ where: { bookingId: fixture.bookingId } });
  await prisma.booking.delete({ where: { id: fixture.bookingId } });
  await prisma.screening.delete({ where: { id: fixture.screeningId } });
  await prisma.screen.delete({ where: { id: fixture.screenId } });
  await prisma.movie.delete({ where: { id: fixture.movieId } });
  await prisma.user.delete({ where: { id: fixture.userId } });
}

async function readLease(prisma: PrismaClient, reconciliationId: string) {
  return prisma.paymentReconciliation.findUniqueOrThrow({
    where: { id: reconciliationId },
    select: {
      status: true,
      result: true,
      nextProcessAt: true,
      retryDeadline: true,
      completedAt: true,
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

describe("PaymentReconciliation claim and lease on PostgreSQL", () => {
  let prisma: PrismaClient;
  let repository: ReconcilePaymentRepository;

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error("DATABASE_URL is required for the PostgreSQL concurrency test.");
    }

    prisma = createClient(databaseUrl);
    await prisma.$connect();
    repository = new ReconcilePaymentRepository({} as never);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("lets only one concurrent claim succeed for the same reconciliation", async () => {
    const now = new Date();
    const fixture = await createFixture(prisma, {
      status: RECONCILIATION_SCHEDULED_STATUS,
      nextProcessAt: new Date(now.getTime() - 1_000),
    });
    const lockAcquired = deferred<number>();
    const releaseHolder = deferred<void>();
    let waiterAcquired = false;

    try {
      const holder = prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`
            SELECT "id" FROM "PaymentReconciliation" WHERE "id" = ${fixture.reconciliationId} FOR UPDATE
          `;
          lockAcquired.resolve(await readBackendPid(tx));
          await releaseHolder.promise;
          return repository.claimDue(tx, fixture.reconciliationId, now);
        },
        { maxWait: TRANSACTION_TIMEOUT_MS, timeout: TRANSACTION_TIMEOUT_MS },
      );

      const holderPid = await lockAcquired.promise;
      const waiter = prisma.$transaction(
        async (tx) => {
          waiterAcquired = true;
          return repository.claimDue(tx, fixture.reconciliationId, now);
        },
        { maxWait: TRANSACTION_TIMEOUT_MS, timeout: TRANSACTION_TIMEOUT_MS },
      );

      await waitUntilBlockedBy(prisma, holderPid);
      expect(waiterAcquired).toBe(true);
      releaseHolder.resolve();

      const [holderResult, waiterResult] = await Promise.all([holder, waiter]);
      const outcomes = [holderResult, waiterResult];
      const claimed = outcomes.find(
        (result) => result.result === CLAIM_RECONCILIATION_RESULT.CLAIMED,
      );
      const rejected = outcomes.find(
        (result) => result.result === CLAIM_RECONCILIATION_RESULT.NOT_CLAIMED,
      );

      expect(claimed?.result).toBe(CLAIM_RECONCILIATION_RESULT.CLAIMED);
      expect(rejected?.result).toBe(CLAIM_RECONCILIATION_RESULT.NOT_CLAIMED);
      if (claimed?.result !== CLAIM_RECONCILIATION_RESULT.CLAIMED) {
        throw new Error("expected exactly one successful claim");
      }

      const lease = await readLease(prisma, fixture.reconciliationId);
      expect(lease.status).toBe(RECONCILIATION_SCHEDULED_STATUS);
      expect(lease.result).toBeNull();
      expect(lease.completedAt).toBeNull();
      expect(lease.leaseToken).toBe(claimed.reconciliation.leaseToken);
      expect(lease.leaseUntil).toEqual(claimed.reconciliation.leaseUntil);
      expect(lease.leaseUntil?.getTime()).toBe(now.getTime() + RECONCILIATION_LEASE_TTL_MS);
    } finally {
      releaseHolder.resolve();
      await deleteFixture(prisma, fixture);
    }
  });

  it("allows reclaim after lease expiry with a new token that alone can release", async () => {
    const now = new Date();
    const expiredToken = randomUUID();
    const fixture = await createFixture(prisma, {
      status: RECONCILIATION_SCHEDULED_STATUS,
      nextProcessAt: new Date(now.getTime() - 60_000),
      leaseToken: expiredToken,
      leaseUntil: new Date(now.getTime() - 1_000),
    });

    try {
      const claimed = await prisma.$transaction((tx) =>
        repository.claimDue(tx, fixture.reconciliationId, now),
      );

      expect(claimed.result).toBe(CLAIM_RECONCILIATION_RESULT.CLAIMED);
      if (claimed.result !== CLAIM_RECONCILIATION_RESULT.CLAIMED) {
        throw new Error("expected reclaim success");
      }
      expect(claimed.reconciliation.leaseToken).not.toBe(expiredToken);

      const releaseWithOldToken = await prisma.$transaction((tx) =>
        repository.releaseLease(tx, fixture.reconciliationId, expiredToken, now),
      );
      expect(releaseWithOldToken).toEqual({
        result: RELEASE_RECONCILIATION_LEASE_RESULT.NOT_HELD,
      });

      const stillHeld = await readLease(prisma, fixture.reconciliationId);
      expect(stillHeld.leaseToken).toBe(claimed.reconciliation.leaseToken);
      expect(stillHeld.leaseUntil).toEqual(claimed.reconciliation.leaseUntil);

      const released = await prisma.$transaction((tx) =>
        repository.releaseLease(
          tx,
          fixture.reconciliationId,
          claimed.reconciliation.leaseToken,
          now,
        ),
      );
      expect(released).toEqual({
        result: RELEASE_RECONCILIATION_LEASE_RESULT.RELEASED,
      });

      const afterRelease = await readLease(prisma, fixture.reconciliationId);
      expect(afterRelease.leaseToken).toBeNull();
      expect(afterRelease.leaseUntil).toBeNull();
      expect(afterRelease.status).toBe(RECONCILIATION_SCHEDULED_STATUS);
    } finally {
      await deleteFixture(prisma, fixture);
    }
  });

  it("does not claim when nextProcessAt is in the future", async () => {
    const now = new Date();
    const fixture = await createFixture(prisma, {
      status: RECONCILIATION_SCHEDULED_STATUS,
      nextProcessAt: new Date(now.getTime() + 60_000),
    });

    try {
      await expect(
        prisma.$transaction((tx) => repository.claimDue(tx, fixture.reconciliationId, now)),
      ).resolves.toEqual({
        result: CLAIM_RECONCILIATION_RESULT.NOT_CLAIMED,
      });
      await expect(readLease(prisma, fixture.reconciliationId)).resolves.toMatchObject({
        leaseToken: null,
        leaseUntil: null,
        status: RECONCILIATION_SCHEDULED_STATUS,
      });
    } finally {
      await deleteFixture(prisma, fixture);
    }
  });

  it.each([
    ["exactly at the retry deadline", 0],
    ["after the retry deadline", -1],
  ])("does not claim when retryDeadline is %s", async (_label, offsetMs) => {
    const now = new Date();
    const fixture = await createFixture(prisma, {
      status: RECONCILIATION_SCHEDULED_STATUS,
      nextProcessAt: new Date(now.getTime() - 1_000),
      retryDeadline: new Date(now.getTime() + offsetMs),
    });

    try {
      await expect(
        prisma.$transaction((tx) => repository.claimDue(tx, fixture.reconciliationId, now)),
      ).resolves.toEqual({
        result: CLAIM_RECONCILIATION_RESULT.NOT_CLAIMED,
      });
      await expect(readLease(prisma, fixture.reconciliationId)).resolves.toMatchObject({
        leaseToken: null,
        leaseUntil: null,
        status: RECONCILIATION_SCHEDULED_STATUS,
      });
    } finally {
      await deleteFixture(prisma, fixture);
    }
  });

  it("does not reclaim an expired lease when retryDeadline has already passed", async () => {
    const now = new Date();
    const expiredToken = randomUUID();
    const fixture = await createFixture(prisma, {
      status: RECONCILIATION_SCHEDULED_STATUS,
      nextProcessAt: new Date(now.getTime() - 60_000),
      retryDeadline: new Date(now.getTime() - 1),
      leaseToken: expiredToken,
      leaseUntil: new Date(now.getTime() - 1_000),
    });

    try {
      await expect(
        prisma.$transaction((tx) => repository.claimDue(tx, fixture.reconciliationId, now)),
      ).resolves.toEqual({
        result: CLAIM_RECONCILIATION_RESULT.NOT_CLAIMED,
      });
      await expect(readLease(prisma, fixture.reconciliationId)).resolves.toMatchObject({
        leaseToken: expiredToken,
        leaseUntil: new Date(now.getTime() - 1_000),
        status: RECONCILIATION_SCHEDULED_STATUS,
      });
    } finally {
      await deleteFixture(prisma, fixture);
    }
  });

  it.each([
    RECONCILIATION_REVIEW_STATUS,
    RECONCILIATION_COMPLETED_STATUS,
  ])("does not claim when status is %s", async (status) => {
    const now = new Date();
    const fixture = await createFixture(prisma, {
      status,
      nextProcessAt: new Date(now.getTime() - 1_000),
      completedAt: status === RECONCILIATION_COMPLETED_STATUS ? now : null,
    });

    try {
      await expect(
        prisma.$transaction((tx) => repository.claimDue(tx, fixture.reconciliationId, now)),
      ).resolves.toEqual({
        result: CLAIM_RECONCILIATION_RESULT.NOT_CLAIMED,
      });
      await expect(readLease(prisma, fixture.reconciliationId)).resolves.toMatchObject({
        leaseToken: null,
        leaseUntil: null,
        status,
      });
    } finally {
      await deleteFixture(prisma, fixture);
    }
  });

  it.each([
    {
      name: "token without until",
      leaseToken: randomUUID(),
      leaseUntil: null,
    },
    {
      name: "until without token",
      leaseToken: null,
      leaseUntil: new Date(Date.now() - 60_000),
    },
  ])("does not claim a half lease ($name)", async ({ leaseToken, leaseUntil }) => {
    const now = new Date();
    const fixture = await createFixture(prisma, {
      status: RECONCILIATION_SCHEDULED_STATUS,
      nextProcessAt: new Date(now.getTime() - 1_000),
      leaseToken,
      leaseUntil,
    });

    try {
      await expect(
        prisma.$transaction((tx) => repository.claimDue(tx, fixture.reconciliationId, now)),
      ).resolves.toEqual({
        result: CLAIM_RECONCILIATION_RESULT.NOT_CLAIMED,
      });
      await expect(readLease(prisma, fixture.reconciliationId)).resolves.toMatchObject({
        leaseToken,
        leaseUntil,
        status: RECONCILIATION_SCHEDULED_STATUS,
      });
    } finally {
      await deleteFixture(prisma, fixture);
    }
  });

  it("does not release after the lease expires even with the old token", async () => {
    const now = new Date();
    const expiredToken = randomUUID();
    const fixture = await createFixture(prisma, {
      status: RECONCILIATION_SCHEDULED_STATUS,
      nextProcessAt: new Date(now.getTime() - 60_000),
      leaseToken: expiredToken,
      leaseUntil: new Date(now.getTime() - 1),
    });

    try {
      await expect(
        prisma.$transaction((tx) =>
          repository.releaseLease(tx, fixture.reconciliationId, expiredToken, now),
        ),
      ).resolves.toEqual({
        result: RELEASE_RECONCILIATION_LEASE_RESULT.NOT_HELD,
      });
      await expect(readLease(prisma, fixture.reconciliationId)).resolves.toMatchObject({
        leaseToken: expiredToken,
        leaseUntil: new Date(now.getTime() - 1),
      });
    } finally {
      await deleteFixture(prisma, fixture);
    }
  });
});

describe("PaymentReconciliation REVIEW past deadline on PostgreSQL", () => {
  let prisma: PrismaClient;
  let repository: ReconcilePaymentRepository;

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error("DATABASE_URL is required for the PostgreSQL concurrency test.");
    }

    prisma = createClient(databaseUrl);
    await prisma.$connect();
    repository = new ReconcilePaymentRepository({} as never);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("marks a past-deadline reconciliation without a lease as REVIEW and then rejects claim", async () => {
    const now = new Date();
    const retryDeadline = new Date(now.getTime() - 1);
    const nextProcessAt = new Date(now.getTime() - 60_000);
    const fixture = await createFixture(prisma, {
      status: RECONCILIATION_SCHEDULED_STATUS,
      nextProcessAt,
      retryDeadline,
      result: RECONCILIATION_RESULT_UNRESOLVED,
    });

    try {
      await expect(
        prisma.$transaction((tx) =>
          repository.markReviewPastDeadline(tx, fixture.reconciliationId, now),
        ),
      ).resolves.toEqual({
        result: MARK_RECONCILIATION_REVIEW_PAST_DEADLINE_RESULT.REVIEWED,
      });

      const afterReview = await readLease(prisma, fixture.reconciliationId);
      expect(afterReview.status).toBe(RECONCILIATION_REVIEW_STATUS);
      expect(afterReview.result).toBe(RECONCILIATION_RESULT_UNRESOLVED);
      expect(afterReview.nextProcessAt).toEqual(nextProcessAt);
      expect(afterReview.retryDeadline).toEqual(retryDeadline);
      expect(afterReview.leaseToken).toBeNull();
      expect(afterReview.leaseUntil).toBeNull();
      expect(afterReview.completedAt).toBeNull();

      await expect(
        prisma.$transaction((tx) => repository.claimDue(tx, fixture.reconciliationId, now)),
      ).resolves.toEqual({
        result: CLAIM_RECONCILIATION_RESULT.NOT_CLAIMED,
      });
    } finally {
      await deleteFixture(prisma, fixture);
    }
  });

  it("protects an active lease from REVIEW and reschedules UNKNOWN without changing result", async () => {
    const now = new Date();
    const leaseToken = randomUUID();
    const leaseUntil = new Date(now.getTime() + RECONCILIATION_LEASE_TTL_MS);
    const retryDeadline = new Date(now.getTime() - 1);
    const nextProcessAt = new Date(now.getTime() - 60_000);
    const fixture = await createFixture(prisma, {
      status: RECONCILIATION_SCHEDULED_STATUS,
      nextProcessAt,
      retryDeadline,
      result: RECONCILIATION_RESULT_UNRESOLVED,
      leaseToken,
      leaseUntil,
    });

    try {
      await expect(
        prisma.$transaction((tx) =>
          repository.markReviewPastDeadline(tx, fixture.reconciliationId, now),
        ),
      ).resolves.toEqual({
        result: MARK_RECONCILIATION_REVIEW_PAST_DEADLINE_RESULT.NOT_ELIGIBLE,
      });

      await expect(
        prisma.$transaction((tx) =>
          repository.rescheduleAfterUnknown(tx, fixture.reconciliationId, leaseToken, now),
        ),
      ).resolves.toEqual({
        result: RESCHEDULE_RECONCILIATION_AFTER_UNKNOWN_RESULT.RESCHEDULED,
      });

      const afterUnknown = await readLease(prisma, fixture.reconciliationId);
      expect(afterUnknown.status).toBe(RECONCILIATION_SCHEDULED_STATUS);
      expect(afterUnknown.result).toBe(RECONCILIATION_RESULT_UNRESOLVED);
      expect(afterUnknown.nextProcessAt).toEqual(
        new Date(now.getTime() + AUTOMATIC_RETRIEVE_INTERVAL_MS),
      );
      expect(afterUnknown.retryDeadline).toEqual(retryDeadline);
      expect(afterUnknown.leaseToken).toBe(leaseToken);
      expect(afterUnknown.leaseUntil).toEqual(leaseUntil);
    } finally {
      await deleteFixture(prisma, fixture);
    }
  });

  it("marks REVIEW after lease expiry past the deadline and then rejects claim", async () => {
    const now = new Date();
    const expiredToken = randomUUID();
    const leaseUntil = new Date(now.getTime() - 1_000);
    const retryDeadline = new Date(now.getTime() - 1);
    const nextProcessAt = new Date(now.getTime() - 60_000);
    const fixture = await createFixture(prisma, {
      status: RECONCILIATION_SCHEDULED_STATUS,
      nextProcessAt,
      retryDeadline,
      result: RECONCILIATION_RESULT_UNRESOLVED,
      leaseToken: expiredToken,
      leaseUntil,
    });

    try {
      await expect(
        prisma.$transaction((tx) =>
          repository.markReviewPastDeadline(tx, fixture.reconciliationId, now),
        ),
      ).resolves.toEqual({
        result: MARK_RECONCILIATION_REVIEW_PAST_DEADLINE_RESULT.REVIEWED,
      });

      const afterReview = await readLease(prisma, fixture.reconciliationId);
      expect(afterReview.status).toBe(RECONCILIATION_REVIEW_STATUS);
      expect(afterReview.result).toBe(RECONCILIATION_RESULT_UNRESOLVED);
      expect(afterReview.nextProcessAt).toEqual(nextProcessAt);
      expect(afterReview.retryDeadline).toEqual(retryDeadline);
      expect(afterReview.leaseToken).toBeNull();
      expect(afterReview.leaseUntil).toBeNull();

      await expect(
        prisma.$transaction((tx) => repository.claimDue(tx, fixture.reconciliationId, now)),
      ).resolves.toEqual({
        result: CLAIM_RECONCILIATION_RESULT.NOT_CLAIMED,
      });
    } finally {
      await deleteFixture(prisma, fixture);
    }
  });

  it("does not mark REVIEW before the retry deadline while claim can still succeed", async () => {
    const now = new Date();
    const fixture = await createFixture(prisma, {
      status: RECONCILIATION_SCHEDULED_STATUS,
      nextProcessAt: new Date(now.getTime() - 1_000),
      retryDeadline: new Date(now.getTime() + 60_000),
    });

    try {
      await expect(
        prisma.$transaction((tx) =>
          repository.markReviewPastDeadline(tx, fixture.reconciliationId, now),
        ),
      ).resolves.toEqual({
        result: MARK_RECONCILIATION_REVIEW_PAST_DEADLINE_RESULT.NOT_ELIGIBLE,
      });

      const claimed = await prisma.$transaction((tx) =>
        repository.claimDue(tx, fixture.reconciliationId, now),
      );
      expect(claimed.result).toBe(CLAIM_RECONCILIATION_RESULT.CLAIMED);
    } finally {
      await deleteFixture(prisma, fixture);
    }
  });

  it.each([
    ["exactly at the retry deadline", 0],
    ["after the retry deadline", -1],
  ])("rejects claim and allows REVIEW when retryDeadline is %s without a lease", async (
    _label,
    offsetMs,
  ) => {
    const now = new Date();
    const fixture = await createFixture(prisma, {
      status: RECONCILIATION_SCHEDULED_STATUS,
      nextProcessAt: new Date(now.getTime() - 1_000),
      retryDeadline: new Date(now.getTime() + offsetMs),
    });

    try {
      await expect(
        prisma.$transaction((tx) => repository.claimDue(tx, fixture.reconciliationId, now)),
      ).resolves.toEqual({
        result: CLAIM_RECONCILIATION_RESULT.NOT_CLAIMED,
      });
      await expect(
        prisma.$transaction((tx) =>
          repository.markReviewPastDeadline(tx, fixture.reconciliationId, now),
        ),
      ).resolves.toEqual({
        result: MARK_RECONCILIATION_REVIEW_PAST_DEADLINE_RESULT.REVIEWED,
      });
      await expect(readLease(prisma, fixture.reconciliationId)).resolves.toMatchObject({
        status: RECONCILIATION_REVIEW_STATUS,
        leaseToken: null,
        leaseUntil: null,
      });
    } finally {
      await deleteFixture(prisma, fixture);
    }
  });

  it("lets only one concurrent REVIEW succeed after waiting on the held row lock", async () => {
    const now = new Date();
    const fixture = await createFixture(prisma, {
      status: RECONCILIATION_SCHEDULED_STATUS,
      nextProcessAt: new Date(now.getTime() - 1_000),
      retryDeadline: new Date(now.getTime() - 1),
    });
    const lockAcquired = deferred<number>();
    const releaseHolder = deferred<void>();
    let waiterAcquired = false;

    try {
      const holder = prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`
            SELECT "id" FROM "PaymentReconciliation" WHERE "id" = ${fixture.reconciliationId} FOR UPDATE
          `;
          lockAcquired.resolve(await readBackendPid(tx));
          await releaseHolder.promise;
          return repository.markReviewPastDeadline(tx, fixture.reconciliationId, now);
        },
        { maxWait: TRANSACTION_TIMEOUT_MS, timeout: TRANSACTION_TIMEOUT_MS },
      );

      const holderPid = await lockAcquired.promise;
      const waiter = prisma.$transaction(
        async (tx) => {
          waiterAcquired = true;
          return repository.markReviewPastDeadline(tx, fixture.reconciliationId, now);
        },
        { maxWait: TRANSACTION_TIMEOUT_MS, timeout: TRANSACTION_TIMEOUT_MS },
      );

      await waitUntilBlockedBy(prisma, holderPid);
      expect(waiterAcquired).toBe(true);
      releaseHolder.resolve();

      const [holderResult, waiterResult] = await Promise.all([holder, waiter]);
      const outcomes = [holderResult, waiterResult];
      const reviewed = outcomes.filter(
        (result) => result.result === MARK_RECONCILIATION_REVIEW_PAST_DEADLINE_RESULT.REVIEWED,
      );
      const rejected = outcomes.filter(
        (result) => result.result === MARK_RECONCILIATION_REVIEW_PAST_DEADLINE_RESULT.NOT_ELIGIBLE,
      );

      expect(reviewed).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      await expect(readLease(prisma, fixture.reconciliationId)).resolves.toMatchObject({
        status: RECONCILIATION_REVIEW_STATUS,
      });
    } finally {
      releaseHolder.resolve();
      await deleteFixture(prisma, fixture);
    }
  });

  it("reevaluates claim vs REVIEW after the held row lock is released at a past deadline", async () => {
    const now = new Date();
    const fixture = await createFixture(prisma, {
      status: RECONCILIATION_SCHEDULED_STATUS,
      nextProcessAt: new Date(now.getTime() - 1_000),
      retryDeadline: new Date(now.getTime() - 1),
    });
    const lockAcquired = deferred<number>();
    const releaseHolder = deferred<void>();
    let waiterAcquired = false;

    try {
      const holder = prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`
            SELECT "id" FROM "PaymentReconciliation" WHERE "id" = ${fixture.reconciliationId} FOR UPDATE
          `;
          lockAcquired.resolve(await readBackendPid(tx));
          await releaseHolder.promise;
          return repository.claimDue(tx, fixture.reconciliationId, now);
        },
        { maxWait: TRANSACTION_TIMEOUT_MS, timeout: TRANSACTION_TIMEOUT_MS },
      );

      const holderPid = await lockAcquired.promise;
      const waiter = prisma.$transaction(
        async (tx) => {
          waiterAcquired = true;
          return repository.markReviewPastDeadline(tx, fixture.reconciliationId, now);
        },
        { maxWait: TRANSACTION_TIMEOUT_MS, timeout: TRANSACTION_TIMEOUT_MS },
      );

      await waitUntilBlockedBy(prisma, holderPid);
      expect(waiterAcquired).toBe(true);
      releaseHolder.resolve();

      const [holderResult, waiterResult] = await Promise.all([holder, waiter]);
      expect(holderResult).toEqual({
        result: CLAIM_RECONCILIATION_RESULT.NOT_CLAIMED,
      });
      expect(waiterResult).toEqual({
        result: MARK_RECONCILIATION_REVIEW_PAST_DEADLINE_RESULT.REVIEWED,
      });
      await expect(readLease(prisma, fixture.reconciliationId)).resolves.toMatchObject({
        status: RECONCILIATION_REVIEW_STATUS,
        leaseToken: null,
        leaseUntil: null,
      });
    } finally {
      releaseHolder.resolve();
      await deleteFixture(prisma, fixture);
    }
  });

});
