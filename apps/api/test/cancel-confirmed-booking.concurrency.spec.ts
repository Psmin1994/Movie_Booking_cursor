/**
 * Test Intent:
 * 같은 CONFIRMED Booking에 대한 동시 확정 취소는 조건부 상태 전이로 하나만 성공한다.
 * 승자만 Booking을 CANCELLED로 바꾸고 좌석을 한 번만 풀며 PENDING Refund를 하나 만든다.
 * 패자는 ALREADY_CANCELLED이며 Booking·좌석·Refund를 바꾸지 않는다.
 * Payment는 PAID로 유지된다.
 */

import { randomInt, randomUUID } from "node:crypto";
import { jest } from "@jest/globals";
import { Prisma, PrismaClient } from "@movie-booking/database-prisma";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  BOOKING_CANCELLED_STATUS,
  BOOKING_CONFIRMED_STATUS,
  CANCEL_CONFIRMED_BOOKING_RESULT,
  SEAT_PRICE,
} from "../src/booking/booking.constants.js";
import { BookingRepository } from "../src/booking/repository/booking.repository.js";
import { BookingSeatReleaseService } from "../src/booking/use-case/booking-seat-release.service.js";
import { createPaymentOrderId } from "../src/payment/create-payment-order-id.js";
import { PAYMENT_PAID_STATUS } from "../src/payment/payment.constants.js";
import { REFUND_PENDING_STATUS } from "../src/refund/refund.constants.js";
import { RefundRepository } from "../src/refund/repository/refund.repository.js";
import {
  SCREENING_SEAT_AVAILABLE_STATUS,
  SCREENING_SEAT_BOOKED_STATUS,
} from "../src/screening/screening.constants.js";
import { ScreeningRepository } from "../src/screening/repository/screening.repository.js";

jest.setTimeout(30_000);

const TRANSACTION_TIMEOUT_MS = 20_000;
const LOCK_WAIT_TIMEOUT_MS = 5_000;

type Tx = Prisma.TransactionClient;

type Fixture = {
  userId: string;
  movieId: string;
  screenId: string;
  screeningId: string;
  screeningSeatId: string;
  bookingId: string;
  paymentId: string;
  amount: number;
};

type CancelOutcome = Awaited<ReturnType<BookingRepository["cancelConfirmedBooking"]>>;

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

type BookingSeatStatusRow = {
  screeningSeat: { status: string };
};

function sleep(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function createClient(databaseUrl: string) {
  const adapter = new PrismaPg({ connectionString: databaseUrl, max: 5 });
  return new PrismaClient({ adapter });
}

async function createFixture(prisma: PrismaClient): Promise<Fixture> {
  const suffix = randomUUID();
  const screen = await prisma.screen.create({
    data: {
      number: randomInt(1_000_000, 2_000_000_000),
      floor: 1,
      screenType: "TEST",
    },
  });
  const movie = await prisma.movie.create({
    data: {
      title: `cancel-confirmed-${suffix}`,
      runtime: 100,
      releaseDate: new Date("2026-01-01"),
    },
  });
  const user = await prisma.user.create({
    data: {
      email: `cancel-confirmed-${suffix}@example.com`,
      passwordHash: "test-hash",
      name: "Cancel Confirmed",
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
  const amount = SEAT_PRICE;
  const booking = await prisma.booking.create({
    data: {
      userId: user.id,
      screeningId: screening.id,
      status: BOOKING_CONFIRMED_STATUS,
      totalAmount: amount,
      expiresAt: new Date(Date.now() - 60_000),
      confirmedAt: new Date(),
    },
  });
  await prisma.bookingSeat.create({
    data: {
      bookingId: booking.id,
      screeningSeatId: screeningSeat.id,
    },
  });
  const payment = await prisma.payment.create({
    data: {
      bookingId: booking.id,
      orderId: createPaymentOrderId(),
      paymentKey: `pay_${suffix}`,
      status: PAYMENT_PAID_STATUS,
      amount,
      paidAt: new Date(),
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
    amount,
  };
}

async function deleteFixture(prisma: PrismaClient, fixture: Fixture) {
  await prisma.refund.deleteMany({ where: { paymentId: fixture.paymentId } });
  await prisma.payment.deleteMany({ where: { bookingId: fixture.bookingId } });
  await prisma.bookingSeat.deleteMany({ where: { bookingId: fixture.bookingId } });
  await prisma.booking.delete({ where: { id: fixture.bookingId } });
  await prisma.screeningSeat.delete({ where: { id: fixture.screeningSeatId } });
  await prisma.seat.deleteMany({ where: { screenId: fixture.screenId } });
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

async function readFinalState(prisma: PrismaClient, fixture: Fixture) {
  const booking = await prisma.booking.findUniqueOrThrow({
    where: { id: fixture.bookingId },
    select: {
      status: true,
      cancelledAt: true,
      payment: { select: { status: true } },
      bookingSeats: {
        select: {
          screeningSeat: { select: { status: true } },
        },
      },
    },
  });
  const refundCount = await prisma.refund.count({
    where: { paymentId: fixture.paymentId },
  });
  const refund = await prisma.refund.findUnique({
    where: { paymentId: fixture.paymentId },
    select: {
      status: true,
      amount: true,
      completedAt: true,
      failedAt: true,
    },
  });

  return {
    bookingStatus: booking.status,
    cancelledAt: booking.cancelledAt,
    paymentStatus: booking.payment?.status ?? null,
    seatStatuses: booking.bookingSeats.map(
      (bookingSeat: BookingSeatStatusRow) => bookingSeat.screeningSeat.status,
    ),
    bookingSeatCount: booking.bookingSeats.length,
    refundCount,
    refund,
  };
}

describe("CancelConfirmedBooking on PostgreSQL", () => {
  let prisma: PrismaClient;
  let bookingRepository: BookingRepository;
  let refundRepository: RefundRepository;
  let bookingSeatReleaseService: BookingSeatReleaseService;

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error("DATABASE_URL is required for the PostgreSQL concurrency test.");
    }

    prisma = createClient(databaseUrl);
    await prisma.$connect();
    bookingRepository = new BookingRepository({} as never);
    refundRepository = new RefundRepository({} as never);
    bookingSeatReleaseService = new BookingSeatReleaseService(
      bookingRepository,
      new ScreeningRepository({} as never),
    );
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function applyCancelConfirmed(tx: Tx, fixture: Fixture): Promise<CancelOutcome> {
    const cancelResult = await bookingRepository.cancelConfirmedBooking(
      tx,
      fixture.bookingId,
      fixture.userId,
    );

    if (cancelResult.result !== CANCEL_CONFIRMED_BOOKING_RESULT.CANCELLED) {
      return cancelResult;
    }

    await bookingSeatReleaseService.release(tx, fixture.bookingId);
    await refundRepository.createPendingRefund(tx, cancelResult.paymentId, cancelResult.amount);
    return cancelResult;
  }

  it("lets only one concurrent confirmed cancellation succeed", async () => {
    const fixture = await createFixture(prisma);
    const lockAcquired = deferred<number>();
    const releaseHolder = deferred<void>();
    let waiterEntered = false;

    try {
      const holder = prisma.$transaction(
        async (tx: Tx) => {
          const cancelResult = await bookingRepository.cancelConfirmedBooking(
            tx,
            fixture.bookingId,
            fixture.userId,
          );
          if (cancelResult.result !== CANCEL_CONFIRMED_BOOKING_RESULT.CANCELLED) {
            throw new Error("Holder should win the confirmed cancellation.");
          }

          lockAcquired.resolve(await readBackendPid(tx));
          await releaseHolder.promise;

          await bookingSeatReleaseService.release(tx, fixture.bookingId);
          await refundRepository.createPendingRefund(
            tx,
            cancelResult.paymentId,
            cancelResult.amount,
          );
          return cancelResult;
        },
        { maxWait: TRANSACTION_TIMEOUT_MS, timeout: TRANSACTION_TIMEOUT_MS },
      );

      void holder.catch((error: unknown) => {
        lockAcquired.reject(error);
      });

      const holderPid = await lockAcquired.promise;
      const waiter = prisma.$transaction(
        async (tx: Tx) => {
          waiterEntered = true;
          return applyCancelConfirmed(tx, fixture);
        },
        { maxWait: TRANSACTION_TIMEOUT_MS, timeout: TRANSACTION_TIMEOUT_MS },
      );

      await waitUntilBlockedBy(prisma, holderPid);
      expect(waiterEntered).toBe(true);
      releaseHolder.resolve();

      const [holderResult, waiterResult] = await Promise.all([holder, waiter]);

      expect(holderResult).toEqual({
        result: CANCEL_CONFIRMED_BOOKING_RESULT.CANCELLED,
        paymentId: fixture.paymentId,
        amount: fixture.amount,
      });
      expect(waiterResult).toEqual({
        result: CANCEL_CONFIRMED_BOOKING_RESULT.ALREADY_CANCELLED,
      });

      const finalState = await readFinalState(prisma, fixture);
      expect(finalState.bookingStatus).toBe(BOOKING_CANCELLED_STATUS);
      expect(finalState.cancelledAt).toBeInstanceOf(Date);
      expect(finalState.paymentStatus).toBe(PAYMENT_PAID_STATUS);
      expect(finalState.seatStatuses).toEqual([SCREENING_SEAT_AVAILABLE_STATUS]);
      expect(finalState.bookingSeatCount).toBe(1);
      expect(finalState.refundCount).toBe(1);
      expect(finalState.refund).toEqual({
        status: REFUND_PENDING_STATUS,
        amount: fixture.amount,
        completedAt: null,
        failedAt: null,
      });
    } finally {
      releaseHolder.resolve();
      await deleteFixture(prisma, fixture);
    }
  });
});
