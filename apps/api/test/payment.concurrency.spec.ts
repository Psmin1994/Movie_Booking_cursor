/**
 * Test Intent:
 * 같은 Payment에서 승인 시작과 만료, 결제 완료와 실패, 승인 기한이 지난 복구가 겹치면 먼저 상태 전이를 잡은 쪽만 확정됨을 보장한다. 복구는 Booking을 CANCELLED로 두고 cancelledAt을 기록하며 좌석을 푼다. 기한 전 결제 완료가 먼저 커밋되면 복구는 그 상태를 바꾸지 않는다. 복구가 먼저 커밋되면 이후 결제 완료는 CONFIRMED가 되지 않는다.
 */

import { randomInt, randomUUID } from "node:crypto";
import { jest } from "@jest/globals";
import { InternalServerErrorException } from "@nestjs/common";
import { Prisma, PrismaClient } from "@movie-booking/database-prisma";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaService } from "../src/database/prisma.service.js";
import { BookingRepository } from "../src/booking/repository/booking.repository.js";
import { BookingSeatReleaseService } from "../src/booking/use-case/booking-seat-release.service.js";
import {
  BOOKING_CONFIRMED_STATUS,
  BOOKING_CANCELLED_STATUS,
  BOOKING_EXPIRED_STATUS,
  BOOKING_FAILED_STATUS,
  BOOKING_PENDING_STATUS,
  SCREENING_SEAT_AVAILABLE_STATUS,
  SCREENING_SEAT_BOOKED_STATUS,
} from "../src/booking/booking.constants.js";
import {
  BEGIN_AUTHORIZATION_RESULT,
  FAIL_PAYMENT_RESULT,
  PAY_PAYMENT_RESULT,
  PAYMENT_AUTHORIZING_STATUS,
  PAYMENT_EXPIRED_STATUS,
  PAYMENT_FAILED_STATUS,
  PAYMENT_PAID_STATUS,
  PAYMENT_PENDING_STATUS,
  PAYMENT_RECONCILIATION_REQUIRED_STATUS,
  RECOVER_AUTHORIZING_PAYMENT_RESULT,
} from "../src/payment/payment.constants.js";
import { PaymentRepository } from "../src/payment/repository/payment.repository.js";
import { ReconcilePaymentRepository } from "../src/payment/repository/reconcile-payment.repository.js";
import { ScreeningRepository } from "../src/screening/repository/screening.repository.js";
import { RecoverAuthorizingPaymentService } from "../src/payment/use-case/recover-authorizing-payment.service.js";

jest.setTimeout(30_000);

const LOCK_WAIT_TIMEOUT_MS = 5_000;
const TRANSACTION_TIMEOUT_MS = 20_000;

type Tx = Prisma.TransactionClient;

type Fixture = {
  userId: string;
  movieId: string;
  screenId: string;
  screeningId: string;
  screeningSeatId: string;
  otherScreeningSeatId: string | null;
  bookingId: string;
  paymentId: string;
  paymentKey: string | null;
  authorizationExpiresAt: Date | null;
};

type FinalState = {
  paymentStatus: string;
  bookingStatus: string;
  seatStatuses: string[];
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
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
    paymentStatus: string;
    expiresAt: Date;
    paymentKey: string | null;
    secondSeatAvailable?: boolean;
  },
): Promise<Fixture> {
  const suffix = randomUUID();
  const user = await prisma.user.create({
    data: {
      email: `payment-lock-${suffix}@example.com`,
      passwordHash: "test-hash",
      name: "Payment Lock Test",
    },
  });
  const movie = await prisma.movie.create({
    data: {
      title: `payment-lock-${suffix}`,
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
  const seat = await prisma.seat.create({
    data: {
      screenId: screen.id,
      row: "Z",
      number: 1,
      seatType: "STANDARD",
    },
  });
  const screeningSeat = await prisma.screeningSeat.create({
    data: {
      screeningId: screening.id,
      seatId: seat.id,
      status: SCREENING_SEAT_BOOKED_STATUS,
    },
  });
  const booking = await prisma.booking.create({
    data: {
      userId: user.id,
      screeningId: screening.id,
      status: BOOKING_PENDING_STATUS,
      totalAmount: 1000,
      expiresAt: input.expiresAt,
    },
  });
  await prisma.bookingSeat.create({
    data: {
      bookingId: booking.id,
      screeningSeatId: screeningSeat.id,
    },
  });
  let otherScreeningSeatId: string | null = null;
  if (input.secondSeatAvailable) {
    const otherSeat = await prisma.seat.create({
      data: {
        screenId: screen.id,
        row: "Z",
        number: 2,
        seatType: "STANDARD",
      },
    });
    const otherScreeningSeat = await prisma.screeningSeat.create({
      data: {
        screeningId: screening.id,
        seatId: otherSeat.id,
        status: SCREENING_SEAT_AVAILABLE_STATUS,
      },
    });
    otherScreeningSeatId = otherScreeningSeat.id;
    await prisma.bookingSeat.create({
      data: {
        bookingId: booking.id,
        screeningSeatId: otherScreeningSeat.id,
      },
    });
  }
  const authorizationExpiresAt =
    input.paymentStatus === PAYMENT_AUTHORIZING_STATUS
      ? new Date(input.expiresAt.getTime() + 15_000)
      : null;
  const payment = await prisma.payment.create({
    data: {
      bookingId: booking.id,
      orderId: `ord_${suffix}`,
      paymentKey: input.paymentKey,
      status: input.paymentStatus,
      amount: 1000,
      authorizationExpiresAt,
    },
  });

  return {
    userId: user.id,
    movieId: movie.id,
    screenId: screen.id,
    screeningId: screening.id,
    screeningSeatId: screeningSeat.id,
    otherScreeningSeatId,
    bookingId: booking.id,
    paymentId: payment.id,
    paymentKey: input.paymentKey,
    authorizationExpiresAt,
  };
}

async function deleteFixture(prisma: PrismaClient, fixture: Fixture) {
  await prisma.paymentReconciliation.deleteMany({ where: { paymentId: fixture.paymentId } });
  await prisma.payment.deleteMany({ where: { bookingId: fixture.bookingId } });
  await prisma.bookingSeat.deleteMany({ where: { bookingId: fixture.bookingId } });
  await prisma.booking.delete({ where: { id: fixture.bookingId } });
  await prisma.screeningSeat.deleteMany({ where: { screeningId: fixture.screeningId } });
  await prisma.seat.deleteMany({ where: { screenId: fixture.screenId } });
  await prisma.screening.delete({ where: { id: fixture.screeningId } });
  await prisma.screen.delete({ where: { id: fixture.screenId } });
  await prisma.movie.delete({ where: { id: fixture.movieId } });
  await prisma.user.delete({ where: { id: fixture.userId } });
}

async function expectSecondTransactionToWait(
  prisma: PrismaClient,
  holderPid: number,
  acquired: () => boolean,
) {
  const observed = await waitUntilWaiterBlockedBy(prisma, holderPid);
  if (acquired()) {
    throw new Error("Waiter finished the competing update before the lock wait was observed.");
  }
  if (!observed.blockers.includes(holderPid) || observed.waiterPid <= 0) {
    throw new Error(`Waiter ${observed.waiterPid} is not blocked by holder ${holderPid}.`);
  }
}

async function waitUntilHolderLocked(holderLocked: () => boolean, holder: Promise<unknown>) {
  let holderError: unknown;
  void holder.catch((error: unknown) => {
    holderError = error;
  });
  const started = Date.now();
  while (!holderLocked() && holderError === undefined && Date.now() - started < LOCK_WAIT_TIMEOUT_MS) {
    await sleep(20);
  }
  if (holderError !== undefined) {
    throw holderError;
  }
  if (!holderLocked()) {
    throw new Error("Timed out waiting for the holder transaction to acquire its lock.");
  }
}

async function readFinalState(prisma: PrismaClient, bookingId: string): Promise<FinalState> {
  const booking = await prisma.booking.findUniqueOrThrow({
    where: { id: bookingId },
    select: {
      status: true,
      payment: { select: { status: true } },
      bookingSeats: {
        select: {
          screeningSeat: { select: { status: true } },
        },
      },
    },
  });

  return {
    paymentStatus: booking.payment?.status ?? "",
    bookingStatus: booking.status,
    seatStatuses: booking.bookingSeats.map((bookingSeat) => bookingSeat.screeningSeat.status),
  };
}

async function expireDuePayment(
  tx: Tx,
  paymentRepository: PaymentRepository,
  bookingRepository: BookingRepository,
  bookingSeatReleaseService: BookingSeatReleaseService,
  paymentId: string,
  now: Date,
) {
  const expired = await paymentRepository.expirePendingPaymentPastExpiry(tx, paymentId, now);

  if (expired.count !== 1 || expired.bookingId === null) {
    return expired.count;
  }

  const bookingExpired = await bookingRepository.expirePendingBookingPastExpiry(tx, expired.bookingId, now);
  if (bookingExpired.count !== 1) {
    throw new Error("Booking expiration did not match the pending booking.");
  }

  await bookingSeatReleaseService.release(tx, expired.bookingId);

  return expired.count;
}

function beforeAuthorizationDeadline(fixture: Fixture): Date {
  if (!fixture.authorizationExpiresAt) {
    throw new Error("Authorizing payment is missing authorizationExpiresAt.");
  }

  return new Date(fixture.authorizationExpiresAt.getTime() - 1);
}

async function payAuthorizing(
  tx: Tx,
  paymentRepository: PaymentRepository,
  bookingRepository: BookingRepository,
  fixture: Fixture,
  now: Date,
) {
  if (!fixture.paymentKey) {
    throw new Error("Authorizing payment is missing paymentKey.");
  }

  const paid = await paymentRepository.payAuthorizingPayment(
    tx,
    fixture.paymentId,
    fixture.userId,
    fixture.paymentKey,
    now,
  );

  if (paid.result !== PAY_PAYMENT_RESULT.PAID) {
    return paid.result;
  }

  if (!paid.payment.paidAt) {
    throw new Error("Paid payment is missing paidAt.");
  }

  const confirmed = await bookingRepository.confirmPendingBooking(
    tx,
    paid.payment.bookingId,
    fixture.userId,
    paid.payment.paidAt,
  );
  if (confirmed.count !== 1) {
    throw new Error("Booking confirmation did not match the pending booking.");
  }

  return paid.result;
}

async function failAuthorizing(
  tx: Tx,
  paymentRepository: PaymentRepository,
  bookingRepository: BookingRepository,
  bookingSeatReleaseService: BookingSeatReleaseService,
  fixture: Fixture,
) {
  const failed = await paymentRepository.failAuthorizingPayment(tx, fixture.paymentId, fixture.userId);

  if (failed.result !== FAIL_PAYMENT_RESULT.FAILED) {
    return failed.result;
  }

  if (!failed.payment.failedAt) {
    throw new Error("Failed payment is missing failedAt.");
  }

  const bookingFailed = await bookingRepository.failPendingBooking(
    tx,
    failed.payment.bookingId,
    fixture.userId,
    failed.payment.failedAt,
  );
  if (bookingFailed.count !== 1) {
    throw new Error("Booking failure did not match the pending booking.");
  }

  await bookingSeatReleaseService.release(tx, failed.payment.bookingId);

  return failed.result;
}

function signal<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function readBackendPid(tx: Tx): Promise<number> {
  const rows = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`;
  const pid = Number(rows[0]?.pid);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error("Could not read the holder backend pid.");
  }
  return pid;
}

async function waitUntilWaiterBlockedBy(
  prisma: PrismaClient,
  holderPid: number,
): Promise<{ waiterPid: number; blockers: number[] }> {
  const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const rows = await prisma.$queryRaw<Array<{ waiterPid: number; blockers: unknown }>>`
      SELECT pid::int AS "waiterPid", pg_blocking_pids(pid) AS blockers
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
        AND ${holderPid}::int = ANY (pg_blocking_pids(pid))
    `;
    const waiterPid = Number(rows[0]?.waiterPid);
    const blockers = asNumberList(rows[0]?.blockers);
    if (Number.isInteger(waiterPid) && waiterPid > 0 && blockers.includes(holderPid)) {
      return { waiterPid, blockers };
    }
    await sleep(25);
  }

  throw new Error(`Timed out waiting for a backend blocked by ${holderPid}.`);
}

function asNumberList(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => Number(item));
}

async function withHeldPaymentLock<THolder, TWaiter>(
  prisma: PrismaClient,
  prepare: (tx: Tx) => Promise<void>,
  finish: (tx: Tx) => Promise<THolder>,
  startWaiter: (markUpdateReturned: () => void) => Promise<TWaiter>,
): Promise<{
  holderResult: PromiseSettledResult<THolder>;
  waiterResult: PromiseSettledResult<TWaiter>;
  waiterPid: number;
}> {
  const releaseHolder = signal<void>();
  const lockAcquired = signal<number>();
  let updateReturned = false;
  let waitingForRelease = false;
  let waiter: Promise<TWaiter> = Promise.resolve(undefined as TWaiter);
  const holder = prisma.$transaction(
    async (tx) => {
      try {
        await prepare(tx);
        lockAcquired.resolve(await readBackendPid(tx));
      } catch (error) {
        lockAcquired.reject(error);
        throw error;
      }
      waitingForRelease = true;
      await releaseHolder.promise;
      return finish(tx);
    },
    { timeout: TRANSACTION_TIMEOUT_MS },
  );
  let holderError: unknown;
  void holder.catch((error: unknown) => {
    holderError = error;
  });
  let released = false;

  try {
    const holderPid = await lockAcquired.promise;
    if (holderError !== undefined) {
      throw holderError;
    }
    waiter = startWaiter(() => {
      updateReturned = true;
    });
    let observed: { waiterPid: number; blockers: number[] };
    try {
      observed = await waitUntilWaiterBlockedBy(prisma, holderPid);
    } catch (error) {
      if (holderError !== undefined) {
        throw holderError;
      }
      throw error;
    }
    if (holderError !== undefined) {
      throw holderError;
    }
    if (updateReturned) {
      throw new Error("Waiter finished the competing update before the lock wait was observed.");
    }
    if (!observed.blockers.includes(holderPid)) {
      throw new Error(`Waiter ${observed.waiterPid} is not blocked by holder ${holderPid}.`);
    }
    releaseHolder.resolve();
    released = true;
    const [holderResult, waiterResult] = await Promise.allSettled([holder, waiter]);
    return { holderResult, waiterResult, waiterPid: observed.waiterPid };
  } finally {
    if (!released && waitingForRelease) {
      releaseHolder.reject(holderError ?? new Error("Holder did not finish."));
    }
    await Promise.allSettled([holder, waiter]);
  }
}

function pastAuthorizationExpiry(): Date {
  return new Date(Date.now() - 60_000);
}

describe("Payment concurrency on PostgreSQL", () => {
  let prisma: PrismaClient;
  let paymentRepository: PaymentRepository;
  let bookingRepository: BookingRepository;
  let screeningRepository: ScreeningRepository;
  let bookingSeatReleaseService: BookingSeatReleaseService;
  let recoverAuthorizingPaymentService: RecoverAuthorizingPaymentService;

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error("DATABASE_URL is required for the PostgreSQL concurrency test.");
    }

    prisma = createClient(databaseUrl);
    await prisma.$connect();
    paymentRepository = new PaymentRepository({} as never);
    bookingRepository = new BookingRepository({} as never);
    screeningRepository = new ScreeningRepository({} as never);
    bookingSeatReleaseService = new BookingSeatReleaseService(bookingRepository, screeningRepository);
    recoverAuthorizingPaymentService = new RecoverAuthorizingPaymentService(
      { client: prisma } as PrismaService,
      paymentRepository,
      bookingRepository,
      bookingSeatReleaseService,
      new ReconcilePaymentRepository({} as never),
    );
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("keeps the payment authorizing when expiration waits on the same row", async () => {
    const expiresAt = new Date(Date.now() + 60_000);
    const authorizeNow = new Date(expiresAt.getTime() - 1_000);
    const expireNow = new Date(expiresAt.getTime() + 1_000);
    const fixture = await createFixture(prisma, {
      paymentStatus: PAYMENT_PENDING_STATUS,
      expiresAt,
      paymentKey: null,
    });
    const releaseHolder = deferred();
    let holderPid = 0;
    let holderLocked = false;
    let waiterAcquired = false;
    let holder: Promise<unknown> = Promise.resolve();
    let waiter: Promise<number> = Promise.resolve(0);

    try {
      holder = prisma.$transaction(
        async (tx) => {
          const authorized = await paymentRepository.beginAuthorization(
            tx,
            fixture.paymentId,
            fixture.userId,
            `pay_${randomUUID()}`,
            authorizeNow,
          );
          if (authorized.result !== BEGIN_AUTHORIZATION_RESULT.AUTHORIZING) {
            throw new Error("beginAuthorization should match the pending payment.");
          }
          holderPid = await readBackendPid(tx);
          holderLocked = true;
          await releaseHolder.promise;
          return authorized.result;
        },
        { timeout: TRANSACTION_TIMEOUT_MS },
      );

      await waitUntilHolderLocked(() => holderLocked, holder);

      waiter = prisma.$transaction(
        async (tx) => {
          const expiredCount = await expireDuePayment(
            tx,
            paymentRepository,
            bookingRepository,
            bookingSeatReleaseService,
            fixture.paymentId,
            expireNow,
          );
          waiterAcquired = true;
          return expiredCount;
        },
        { timeout: TRANSACTION_TIMEOUT_MS },
      );

      await expectSecondTransactionToWait(prisma, holderPid, () => waiterAcquired);
      releaseHolder.resolve();
      await expect(holder).resolves.toBe(BEGIN_AUTHORIZATION_RESULT.AUTHORIZING);
      await expect(waiter).resolves.toBe(0);
      await expect(readFinalState(prisma, fixture.bookingId)).resolves.toEqual({
        paymentStatus: PAYMENT_AUTHORIZING_STATUS,
        bookingStatus: BOOKING_PENDING_STATUS,
        seatStatuses: [SCREENING_SEAT_BOOKED_STATUS],
      });
    } finally {
      releaseHolder.resolve();
      await Promise.allSettled([holder, waiter]);
      await deleteFixture(prisma, fixture);
    }
  });

  it("expires the payment when authorization waits on the same row", async () => {
    const expiresAt = new Date(Date.now() + 60_000);
    const authorizeNow = new Date(expiresAt.getTime() - 1_000);
    const expireNow = new Date(expiresAt.getTime() + 1_000);
    const fixture = await createFixture(prisma, {
      paymentStatus: PAYMENT_PENDING_STATUS,
      expiresAt,
      paymentKey: null,
    });
    const releaseHolder = deferred();
    let holderPid = 0;
    let holderLocked = false;
    let waiterAcquired = false;
    let holder: Promise<number> = Promise.resolve(0);
    let waiter: Promise<unknown> = Promise.resolve();

    try {
      holder = prisma.$transaction(
        async (tx) => {
          const expiredCount = await expireDuePayment(
            tx,
            paymentRepository,
            bookingRepository,
            bookingSeatReleaseService,
            fixture.paymentId,
            expireNow,
          );
          if (expiredCount !== 1) {
            throw new Error("Expiration should match the pending payment.");
          }
          holderPid = await readBackendPid(tx);
          holderLocked = true;
          await releaseHolder.promise;
          return expiredCount;
        },
        { timeout: TRANSACTION_TIMEOUT_MS },
      );

      await waitUntilHolderLocked(() => holderLocked, holder);

      waiter = prisma.$transaction(
        async (tx) => {
          const authorized = await paymentRepository.beginAuthorization(
            tx,
            fixture.paymentId,
            fixture.userId,
            `pay_${randomUUID()}`,
            authorizeNow,
          );
          waiterAcquired = true;
          return authorized.result;
        },
        { timeout: TRANSACTION_TIMEOUT_MS },
      );

      await expectSecondTransactionToWait(prisma, holderPid, () => waiterAcquired);
      releaseHolder.resolve();
      await expect(holder).resolves.toBe(1);
      await expect(waiter).resolves.toBe(BEGIN_AUTHORIZATION_RESULT.NOT_ELIGIBLE);
      await expect(readFinalState(prisma, fixture.bookingId)).resolves.toEqual({
        paymentStatus: PAYMENT_EXPIRED_STATUS,
        bookingStatus: BOOKING_EXPIRED_STATUS,
        seatStatuses: [SCREENING_SEAT_AVAILABLE_STATUS],
      });
    } finally {
      releaseHolder.resolve();
      await Promise.allSettled([holder, waiter]);
      await deleteFixture(prisma, fixture);
    }
  });

  it("does not expire an authorizing payment after the booking hold ends", async () => {
    const paymentKey = `pay_${randomUUID()}`;
    const fixture = await createFixture(prisma, {
      paymentStatus: PAYMENT_AUTHORIZING_STATUS,
      expiresAt: pastAuthorizationExpiry(),
      paymentKey,
    });

    try {
      const now = new Date();
      const expiredPayments = await prisma.$transaction((tx) =>
        expireDuePayment(
          tx,
          paymentRepository,
          bookingRepository,
          bookingSeatReleaseService,
          fixture.paymentId,
          now,
        ),
      );
      const expiredBookings = await prisma.$transaction((tx) =>
        bookingRepository.expirePendingBookingWithoutPayment(tx, fixture.bookingId, now),
      );

      expect(expiredPayments).toBe(0);
      expect(expiredBookings.count).toBe(0);
      await expect(readFinalState(prisma, fixture.bookingId)).resolves.toEqual({
        paymentStatus: PAYMENT_AUTHORIZING_STATUS,
        bookingStatus: BOOKING_PENDING_STATUS,
        seatStatuses: [SCREENING_SEAT_BOOKED_STATUS],
      });
    } finally {
      await deleteFixture(prisma, fixture);
    }
  });

  it("keeps the payment paid when failure waits on the same row", async () => {
    const paymentKey = `pay_${randomUUID()}`;
    const fixture = await createFixture(prisma, {
      paymentStatus: PAYMENT_AUTHORIZING_STATUS,
      expiresAt: new Date(Date.now() + 60_000),
      paymentKey,
    });
    const releaseHolder = deferred();
    let holderPid = 0;
    let holderLocked = false;
    let waiterAcquired = false;
    let holder: Promise<string> = Promise.resolve("");
    let waiter: Promise<string> = Promise.resolve("");

    try {
      holder = prisma.$transaction(
        async (tx) => {
          const paid = await payAuthorizing(tx, paymentRepository, bookingRepository, fixture, beforeAuthorizationDeadline(fixture));
          if (paid !== PAY_PAYMENT_RESULT.PAID) {
            throw new Error("payAuthorizingPayment should match the authorizing payment.");
          }
          holderPid = await readBackendPid(tx);
          holderLocked = true;
          await releaseHolder.promise;
          return paid;
        },
        { timeout: TRANSACTION_TIMEOUT_MS },
      );

      await waitUntilHolderLocked(() => holderLocked, holder);

      waiter = prisma.$transaction(
        async (tx) => {
          const failed = await failAuthorizing(
            tx,
            paymentRepository,
            bookingRepository,
            bookingSeatReleaseService,
            fixture,
          );
          waiterAcquired = true;
          return failed;
        },
        { timeout: TRANSACTION_TIMEOUT_MS },
      );

      await expectSecondTransactionToWait(prisma, holderPid, () => waiterAcquired);
      releaseHolder.resolve();
      await expect(holder).resolves.toBe(PAY_PAYMENT_RESULT.PAID);
      await expect(waiter).resolves.toBe(FAIL_PAYMENT_RESULT.NOT_AUTHORIZING);
      await expect(readFinalState(prisma, fixture.bookingId)).resolves.toEqual({
        paymentStatus: PAYMENT_PAID_STATUS,
        bookingStatus: BOOKING_CONFIRMED_STATUS,
        seatStatuses: [SCREENING_SEAT_BOOKED_STATUS],
      });
    } finally {
      releaseHolder.resolve();
      await Promise.allSettled([holder, waiter]);
      await deleteFixture(prisma, fixture);
    }
  });

  it("fails the payment and releases seats when pay waits on the same row", async () => {
    const paymentKey = `pay_${randomUUID()}`;
    const fixture = await createFixture(prisma, {
      paymentStatus: PAYMENT_AUTHORIZING_STATUS,
      expiresAt: new Date(Date.now() + 60_000),
      paymentKey,
    });
    const releaseHolder = deferred();
    let holderPid = 0;
    let holderLocked = false;
    let waiterAcquired = false;
    let holder: Promise<string> = Promise.resolve("");
    let waiter: Promise<string> = Promise.resolve("");

    try {
      holder = prisma.$transaction(
        async (tx) => {
          const failed = await failAuthorizing(
            tx,
            paymentRepository,
            bookingRepository,
            bookingSeatReleaseService,
            fixture,
          );
          if (failed !== FAIL_PAYMENT_RESULT.FAILED) {
            throw new Error("failAuthorizingPayment should match the authorizing payment.");
          }
          const payment = await tx.payment.findUniqueOrThrow({
            where: { id: fixture.paymentId },
            select: { status: true },
          });
          const booking = await tx.booking.findUniqueOrThrow({
            where: { id: fixture.bookingId },
            select: { status: true },
          });
          const seat = await tx.screeningSeat.findUniqueOrThrow({
            where: { id: fixture.screeningSeatId },
            select: { status: true },
          });
          if (
            payment.status !== PAYMENT_FAILED_STATUS ||
            booking.status !== BOOKING_FAILED_STATUS ||
            seat.status !== SCREENING_SEAT_AVAILABLE_STATUS
          ) {
            throw new Error("Failure changes were not visible in the same transaction.");
          }
          holderPid = await readBackendPid(tx);
          holderLocked = true;
          await releaseHolder.promise;
          return failed;
        },
        { timeout: TRANSACTION_TIMEOUT_MS },
      );

      await waitUntilHolderLocked(() => holderLocked, holder);

      waiter = prisma.$transaction(
        async (tx) => {
          const paid = await payAuthorizing(tx, paymentRepository, bookingRepository, fixture, beforeAuthorizationDeadline(fixture));
          waiterAcquired = true;
          return paid;
        },
        { timeout: TRANSACTION_TIMEOUT_MS },
      );

      await expectSecondTransactionToWait(prisma, holderPid, () => waiterAcquired);
      releaseHolder.resolve();
      await expect(holder).resolves.toBe(FAIL_PAYMENT_RESULT.FAILED);
      await expect(waiter).resolves.toBe(PAY_PAYMENT_RESULT.NOT_AUTHORIZING);
      await expect(readFinalState(prisma, fixture.bookingId)).resolves.toEqual({
        paymentStatus: PAYMENT_FAILED_STATUS,
        bookingStatus: BOOKING_FAILED_STATUS,
        seatStatuses: [SCREENING_SEAT_AVAILABLE_STATUS],
      });
    } finally {
      releaseHolder.resolve();
      await Promise.allSettled([holder, waiter]);
      await deleteFixture(prisma, fixture);
    }
  });

  it("rolls back seat release without leaving a failed payment for the waiting pay transaction", async () => {
    const paymentKey = `pay_${randomUUID()}`;
    const fixture = await createFixture(prisma, {
      paymentStatus: PAYMENT_AUTHORIZING_STATUS,
      expiresAt: new Date(Date.now() + 60_000),
      paymentKey,
    });
    const releaseHolder = deferred();
    let holderPid = 0;
    let holderLocked = false;
    let waiterAcquired = false;
    let holder: Promise<unknown> = Promise.resolve();
    let waiter: Promise<string> = Promise.resolve("");

    try {
      holder = prisma.$transaction(
        async (tx) => {
          const failed = await failAuthorizing(
            tx,
            paymentRepository,
            bookingRepository,
            bookingSeatReleaseService,
            fixture,
          );
          if (failed !== FAIL_PAYMENT_RESULT.FAILED) {
            throw new Error("failAuthorizingPayment should match the authorizing payment.");
          }
          const seat = await tx.screeningSeat.findUniqueOrThrow({
            where: { id: fixture.screeningSeatId },
            select: { status: true },
          });
          if (seat.status !== SCREENING_SEAT_AVAILABLE_STATUS) {
            throw new Error("Seat release was not applied in the open transaction.");
          }
          holderPid = await readBackendPid(tx);
          holderLocked = true;
          await releaseHolder.promise;
          throw new Error("rollback");
        },
        { timeout: TRANSACTION_TIMEOUT_MS },
      );

      await waitUntilHolderLocked(() => holderLocked, holder);

      waiter = prisma.$transaction(
        async (tx) => {
          const paid = await payAuthorizing(tx, paymentRepository, bookingRepository, fixture, beforeAuthorizationDeadline(fixture));
          waiterAcquired = true;
          return paid;
        },
        { timeout: TRANSACTION_TIMEOUT_MS },
      );

      await expectSecondTransactionToWait(prisma, holderPid, () => waiterAcquired);
      releaseHolder.resolve();
      await expect(holder).rejects.toThrow("rollback");
      await expect(waiter).resolves.toBe(PAY_PAYMENT_RESULT.PAID);
      await expect(readFinalState(prisma, fixture.bookingId)).resolves.toEqual({
        paymentStatus: PAYMENT_PAID_STATUS,
        bookingStatus: BOOKING_CONFIRMED_STATUS,
        seatStatuses: [SCREENING_SEAT_BOOKED_STATUS],
      });
    } finally {
      releaseHolder.resolve();
      await Promise.allSettled([holder, waiter]);
      await deleteFixture(prisma, fixture);
    }
  });

  it("leaves the paid booking unchanged when recovery runs after pay commits", async () => {
    const paymentKey = `pay_${randomUUID()}`;
    const fixture = await createFixture(prisma, {
      paymentStatus: PAYMENT_AUTHORIZING_STATUS,
      expiresAt: pastAuthorizationExpiry(),
      paymentKey,
    });

    try {
      await prisma.$transaction(
        async (tx) => {
          const paid = await payAuthorizing(tx, paymentRepository, bookingRepository, fixture, beforeAuthorizationDeadline(fixture));
          if (paid !== PAY_PAYMENT_RESULT.PAID) {
            throw new Error("payAuthorizingPayment should match the authorizing payment.");
          }
        },
        { timeout: TRANSACTION_TIMEOUT_MS },
      );
      const afterPay = await readFinalState(prisma, fixture.bookingId);

      await expect(recoverAuthorizingPaymentService.execute(fixture.paymentId)).resolves.toEqual({
        result: RECOVER_AUTHORIZING_PAYMENT_RESULT.NOT_ELIGIBLE,
      });
      await expect(readFinalState(prisma, fixture.bookingId)).resolves.toEqual(afterPay);
      expect(afterPay).toEqual({
        paymentStatus: PAYMENT_PAID_STATUS,
        bookingStatus: BOOKING_CONFIRMED_STATUS,
        seatStatuses: [SCREENING_SEAT_BOOKED_STATUS],
      });
    } finally {
      await deleteFixture(prisma, fixture);
    }
  });

  it("leaves the recovered booking unchanged when pay runs after recovery commits", async () => {
    const paymentKey = `pay_${randomUUID()}`;
    const fixture = await createFixture(prisma, {
      paymentStatus: PAYMENT_AUTHORIZING_STATUS,
      expiresAt: pastAuthorizationExpiry(),
      paymentKey,
    });

    try {
      await expect(recoverAuthorizingPaymentService.execute(fixture.paymentId)).resolves.toEqual({
        result: RECOVER_AUTHORIZING_PAYMENT_RESULT.RECONCILIATION_REQUIRED,
      });
      const afterRecovery = await readFinalState(prisma, fixture.bookingId);

      await prisma.$transaction(
        async (tx) => {
          const paid = await payAuthorizing(tx, paymentRepository, bookingRepository, fixture, beforeAuthorizationDeadline(fixture));
          if (paid !== PAY_PAYMENT_RESULT.NOT_AUTHORIZING) {
            throw new Error("payAuthorizingPayment should lose after recovery commits.");
          }
        },
        { timeout: TRANSACTION_TIMEOUT_MS },
      );

      await expect(readFinalState(prisma, fixture.bookingId)).resolves.toEqual(afterRecovery);
      expect(afterRecovery).toEqual({
        paymentStatus: PAYMENT_RECONCILIATION_REQUIRED_STATUS,
        bookingStatus: BOOKING_CANCELLED_STATUS,
        seatStatuses: [SCREENING_SEAT_AVAILABLE_STATUS],
      });
    } finally {
      await deleteFixture(prisma, fixture);
    }
  });

  it("pays the booking when a blocked pay waits through a rolled-back recovery", async () => {
    const paymentKey = `pay_${randomUUID()}`;
    const fixture = await createFixture(prisma, {
      paymentStatus: PAYMENT_AUTHORIZING_STATUS,
      expiresAt: pastAuthorizationExpiry(),
      paymentKey,
      secondSeatAvailable: true,
    });

    try {
      const race = await withHeldPaymentLock(
        prisma,
        async (tx) => {
          const recovered = await recoverAuthorizing(
            tx,
            paymentRepository,
            bookingRepository,
            screeningRepository,
            fixture,
            new Date(),
          );
          if (recovered.seatCount !== 2 || recovered.releasedCount !== 1) {
            throw new Error("Seat release should disagree with the booking seats.");
          }
        },
        async () => {
          throw new InternalServerErrorException();
        },
        (markUpdateReturned) =>
          prisma.$transaction(
            async (tx) => {
              const paid = await payAuthorizing(tx, paymentRepository, bookingRepository, fixture, beforeAuthorizationDeadline(fixture));
              markUpdateReturned();
              return paid;
            },
            { timeout: TRANSACTION_TIMEOUT_MS },
          ),
      );

      expect(race.waiterPid).toBeGreaterThan(0);
      expect(race.holderResult.status).toBe("rejected");
      if (race.holderResult.status === "rejected") {
        expect(race.holderResult.reason).toBeInstanceOf(InternalServerErrorException);
      }
      expect(race.waiterResult).toEqual({
        status: "fulfilled",
        value: PAY_PAYMENT_RESULT.PAID,
      });
      await expect(readPaymentBookingAndSeats(prisma, fixture)).resolves.toEqual({
        paymentStatus: PAYMENT_PAID_STATUS,
        bookingStatus: BOOKING_CONFIRMED_STATUS,
        bookedSeatStatus: SCREENING_SEAT_BOOKED_STATUS,
        otherSeatStatus: SCREENING_SEAT_AVAILABLE_STATUS,
      });
    } finally {
      await deleteFixture(prisma, fixture);
    }
  });

  it("keeps the paid booking when recovery waits on the payment row", async () => {
    const paymentKey = `pay_${randomUUID()}`;
    const fixture = await createFixture(prisma, {
      paymentStatus: PAYMENT_AUTHORIZING_STATUS,
      expiresAt: pastAuthorizationExpiry(),
      paymentKey,
    });

    try {
      const race = await withHeldPaymentLock(
        prisma,
        async (tx) => {
          const paid = await payAuthorizing(tx, paymentRepository, bookingRepository, fixture, beforeAuthorizationDeadline(fixture));
          if (paid !== PAY_PAYMENT_RESULT.PAID) {
            throw new Error("payAuthorizingPayment should match the authorizing payment.");
          }
        },
        async () => PAY_PAYMENT_RESULT.PAID,
        (markUpdateReturned) =>
          recoverAuthorizingPaymentService.execute(fixture.paymentId).then((result) => {
            markUpdateReturned();
            return result;
          }),
      );

      expect(race.waiterPid).toBeGreaterThan(0);
      expect(race.holderResult).toEqual({
        status: "fulfilled",
        value: PAY_PAYMENT_RESULT.PAID,
      });
      expect(race.waiterResult).toEqual({
        status: "fulfilled",
        value: { result: RECOVER_AUTHORIZING_PAYMENT_RESULT.NOT_ELIGIBLE },
      });
      await expect(readFinalState(prisma, fixture.bookingId)).resolves.toEqual({
        paymentStatus: PAYMENT_PAID_STATUS,
        bookingStatus: BOOKING_CONFIRMED_STATUS,
        seatStatuses: [SCREENING_SEAT_BOOKED_STATUS],
      });
    } finally {
      await deleteFixture(prisma, fixture);
    }
  });

  it("keeps the recovered booking when pay waits on the payment row", async () => {
    const paymentKey = `pay_${randomUUID()}`;
    const fixture = await createFixture(prisma, {
      paymentStatus: PAYMENT_AUTHORIZING_STATUS,
      expiresAt: pastAuthorizationExpiry(),
      paymentKey,
    });

    try {
      const race = await withHeldPaymentLock(
        prisma,
        async (tx) => {
          const recovered = await recoverAuthorizing(
            tx,
            paymentRepository,
            bookingRepository,
            screeningRepository,
            fixture,
            new Date(),
          );
          if (recovered.outcome !== "RECONCILED" || recovered.releasedCount !== recovered.seatCount) {
            throw new Error("Recovery should match the authorizing payment.");
          }
          const payment = await tx.payment.findUniqueOrThrow({
            where: { id: fixture.paymentId },
            select: { status: true },
          });
          const booking = await tx.booking.findUniqueOrThrow({
            where: { id: fixture.bookingId },
            select: { status: true },
          });
          const seat = await tx.screeningSeat.findUniqueOrThrow({
            where: { id: fixture.screeningSeatId },
            select: { status: true },
          });
          if (
            payment.status !== PAYMENT_RECONCILIATION_REQUIRED_STATUS ||
            booking.status !== BOOKING_CANCELLED_STATUS ||
            seat.status !== SCREENING_SEAT_AVAILABLE_STATUS
          ) {
            throw new Error("Recovery changes were not visible in the open transaction.");
          }
        },
        async () => RECOVER_AUTHORIZING_PAYMENT_RESULT.RECONCILIATION_REQUIRED,
        (markUpdateReturned) =>
          prisma.$transaction(
            async (tx) => {
              const paid = await payAuthorizing(tx, paymentRepository, bookingRepository, fixture, beforeAuthorizationDeadline(fixture));
              markUpdateReturned();
              return paid;
            },
            { timeout: TRANSACTION_TIMEOUT_MS },
          ),
      );

      expect(race.waiterPid).toBeGreaterThan(0);
      expect(race.holderResult).toEqual({
        status: "fulfilled",
        value: RECOVER_AUTHORIZING_PAYMENT_RESULT.RECONCILIATION_REQUIRED,
      });
      expect(race.waiterResult).toEqual({
        status: "fulfilled",
        value: PAY_PAYMENT_RESULT.NOT_AUTHORIZING,
      });
      await expect(readFinalState(prisma, fixture.bookingId)).resolves.toEqual({
        paymentStatus: PAYMENT_RECONCILIATION_REQUIRED_STATUS,
        bookingStatus: BOOKING_CANCELLED_STATUS,
        seatStatuses: [SCREENING_SEAT_AVAILABLE_STATUS],
      });
    } finally {
      await deleteFixture(prisma, fixture);
    }
  });

  it("does not confirm a payment when pay runs at the authorization deadline", async () => {
    const paymentKey = `pay_${randomUUID()}`;
    const fixture = await createFixture(prisma, {
      paymentStatus: PAYMENT_AUTHORIZING_STATUS,
      expiresAt: pastAuthorizationExpiry(),
      paymentKey,
    });

    try {
      if (!fixture.authorizationExpiresAt) {
        throw new Error("Authorizing payment is missing authorizationExpiresAt.");
      }

      await prisma.$transaction(async (tx) => {
        const paid = await payAuthorizing(
          tx,
          paymentRepository,
          bookingRepository,
          fixture,
          fixture.authorizationExpiresAt ?? new Date(),
        );
        if (paid !== PAY_PAYMENT_RESULT.NOT_AUTHORIZING) {
          throw new Error("payAuthorizingPayment should reject the exact authorization deadline.");
        }
      });

      await expect(readFinalState(prisma, fixture.bookingId)).resolves.toEqual({
        paymentStatus: PAYMENT_AUTHORIZING_STATUS,
        bookingStatus: BOOKING_PENDING_STATUS,
        seatStatuses: [SCREENING_SEAT_BOOKED_STATUS],
      });
    } finally {
      await deleteFixture(prisma, fixture);
    }
  });
});

async function recoverAuthorizing(
  tx: Tx,
  paymentRepository: PaymentRepository,
  bookingRepository: BookingRepository,
  screeningRepository: ScreeningRepository,
  fixture: Fixture,
  now: Date,
) {
  const recovered = await paymentRepository.recoverAuthorizingPaymentPastDeadline(
    tx,
    fixture.paymentId,
    now,
  );
  if (recovered.count !== 1 || recovered.bookingId === null || recovered.userId === null) {
    return { outcome: "NOT_ELIGIBLE" as const, releasedCount: 0, seatCount: 0 };
  }

  const bookingCancelled = await bookingRepository.cancelPendingBookingForReconciliation(
    tx,
    recovered.bookingId,
    recovered.userId,
    now,
  );
  if (bookingCancelled.count !== 1) {
    throw new Error("Booking cancellation did not match the pending booking.");
  }

  const bookingSeats = await bookingRepository.findBookingSeatsByBookingId(tx, recovered.bookingId);
  const screeningSeatIds = bookingSeats.map((bookingSeat) => bookingSeat.screeningSeatId);
  const released =
    screeningSeatIds.length === 0
      ? { count: 0 }
      : await screeningRepository.releaseBookedSeats(tx, screeningSeatIds);

  return {
    outcome: "RECONCILED" as const,
    releasedCount: released.count,
    seatCount: screeningSeatIds.length,
  };
}

async function readPaymentBookingAndSeats(prisma: PrismaClient, fixture: Fixture) {
  const payment = await prisma.payment.findUniqueOrThrow({
    where: { id: fixture.paymentId },
    select: { status: true },
  });
  const booking = await prisma.booking.findUniqueOrThrow({
    where: { id: fixture.bookingId },
    select: { status: true },
  });
  const bookedSeat = await prisma.screeningSeat.findUniqueOrThrow({
    where: { id: fixture.screeningSeatId },
    select: { status: true },
  });
  const otherSeat = await prisma.screeningSeat.findUniqueOrThrow({
    where: { id: fixture.otherScreeningSeatId ?? "" },
    select: { status: true },
  });

  return {
    paymentStatus: payment.status,
    bookingStatus: booking.status,
    bookedSeatStatus: bookedSeat.status,
    otherSeatStatus: otherSeat.status,
  };
}
