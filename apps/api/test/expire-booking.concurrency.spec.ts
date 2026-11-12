/**
 * Test Intent:
 * 같은 Booking에서 결제 생성과 예매 만료가 겹치면 Booking 잠금을 먼저 잡은 쪽만 확정됨을 보장한다. 결제가 먼저면 PENDING Payment와 좌석 점유가 남고, 만료가 먼저면 결제는 생기지 않고 좌석은 풀린다.
 */

import { randomInt, randomUUID } from "node:crypto";
import { jest } from "@jest/globals";
import { ConflictException } from "@nestjs/common";
import { Prisma, PrismaClient } from "@movie-booking/database-prisma";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  BOOKING_EXPIRED_STATUS,
  BOOKING_PENDING_STATUS,
} from "../src/booking/booking.constants.js";
import { BookingRepository } from "../src/booking/repository/booking.repository.js";
import { BookingSeatReleaseService } from "../src/booking/use-case/booking-seat-release.service.js";
import { createPaymentOrderId } from "../src/payment/create-payment-order-id.js";
import { PAYMENT_PENDING_STATUS } from "../src/payment/payment.constants.js";
import { PaymentRepository } from "../src/payment/repository/payment.repository.js";
import {
  SCREENING_SEAT_AVAILABLE_STATUS,
  SCREENING_SEAT_BOOKED_STATUS,
} from "../src/screening/screening.constants.js";
import { ScreeningRepository } from "../src/screening/repository/screening.repository.js";

jest.setTimeout(30_000);

const TRANSACTION_TIMEOUT_MS = 20_000;
const LOCK_WAIT_TIMEOUT_MS = 5_000;
const PAST_EXPIRY = new Date("2000-01-01T00:00:00.000Z");

type Tx = Prisma.TransactionClient;

type Fixture = {
  userId: string;
  movieId: string;
  screenId: string;
  screeningId: string;
  screeningSeatId: string;
  bookingId: string;
  totalAmount: number;
};

type FinalState = {
  bookingStatus: string;
  paymentStatus: string | null;
  seatStatuses: string[];
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
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
      title: `lock-test-${suffix}`,
      runtime: 100,
      releaseDate: new Date("2026-01-01"),
    },
  });
  const user = await prisma.user.create({
    data: {
      email: `lock-test-${suffix}@example.com`,
      passwordHash: "test-hash",
      name: "Lock Test",
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
  const totalAmount = 1000;
  const booking = await prisma.booking.create({
    data: {
      userId: user.id,
      screeningId: screening.id,
      status: BOOKING_PENDING_STATUS,
      totalAmount,
      expiresAt: PAST_EXPIRY,
    },
  });
  await prisma.bookingSeat.create({
    data: {
      bookingId: booking.id,
      screeningSeatId: screeningSeat.id,
    },
  });

  return {
    userId: user.id,
    movieId: movie.id,
    screenId: screen.id,
    screeningId: screening.id,
    screeningSeatId: screeningSeat.id,
    bookingId: booking.id,
    totalAmount,
  };
}

async function deleteFixture(prisma: PrismaClient, fixture: Fixture) {
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
  const rows = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
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
    bookingStatus: booking.status,
    paymentStatus: booking.payment?.status ?? null,
    seatStatuses: booking.bookingSeats.map((bookingSeat) => bookingSeat.screeningSeat.status),
  };
}

describe("CreatePayment and ExpireBooking on PostgreSQL", () => {
  let prisma: PrismaClient;
  let bookingRepository: BookingRepository;
  let paymentRepository: PaymentRepository;
  let screeningRepository: ScreeningRepository;
  let bookingSeatReleaseService: BookingSeatReleaseService;

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error("DATABASE_URL is required for the PostgreSQL concurrency test.");
    }

    prisma = createClient(databaseUrl);
    await prisma.$connect();
    bookingRepository = new BookingRepository({} as never);
    paymentRepository = new PaymentRepository({} as never);
    screeningRepository = new ScreeningRepository({} as never);
    bookingSeatReleaseService = new BookingSeatReleaseService(bookingRepository, screeningRepository);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function raceOnBookingLock<THolder, TWaiter>(
    fixture: Fixture,
    hold: (tx: Tx) => Promise<THolder>,
    wait: (tx: Tx) => Promise<TWaiter>,
  ): Promise<{ holderResult: THolder; waiterResult: TWaiter }> {
    const lockAcquired = deferred<number>();
    const releaseHolder = deferred<void>();
    let waiterAcquired = false;
    const holder = prisma.$transaction(
      async (tx) => {
        await bookingRepository.lockBookingById(tx, fixture.bookingId);
        lockAcquired.resolve(await readBackendPid(tx));
        await releaseHolder.promise;
        return hold(tx);
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    );
    void holder.catch((error: unknown) => {
      lockAcquired.reject(error);
    });

    let waiter: Promise<TWaiter> = Promise.resolve(undefined as TWaiter);
    try {
      const holderPid = await lockAcquired.promise;
      waiter = prisma.$transaction(
        async (tx) => {
          await bookingRepository.lockBookingById(tx, fixture.bookingId);
          waiterAcquired = true;
          return wait(tx);
        },
        { timeout: TRANSACTION_TIMEOUT_MS },
      );

      await waitUntilBlockedBy(prisma, holderPid);
      expect(waiterAcquired).toBe(false);
      releaseHolder.resolve();
      return {
        holderResult: await holder,
        waiterResult: await waiter,
      };
    } finally {
      releaseHolder.reject(new Error("Holder did not commit."));
      await Promise.allSettled([holder, waiter]);
    }
  }

  it("keeps the pending payment when CreatePayment holds the booking lock first", async () => {
    const fixture = await createFixture(prisma);

    try {
      const { waiterResult } = await raceOnBookingLock(
        fixture,
        async (tx) => {
          const booking = await bookingRepository.findBookingByIdAndUserId(
            tx,
            fixture.bookingId,
            fixture.userId,
          );
          if (!booking) {
            throw new Error("Booking disappeared before CreatePayment.");
          }

          await paymentRepository.createPendingPayment(
            tx,
            fixture.bookingId,
            booking.totalAmount,
            createPaymentOrderId(),
          );
        },
        async (tx) => {
          const expired = await bookingRepository.expirePendingBookingWithoutPayment(
            tx,
            fixture.bookingId,
            new Date(),
          );
          if (expired.count !== 1) {
            return expired.count;
          }

          await bookingSeatReleaseService.release(tx, fixture.bookingId);
          return expired.count;
        },
      );

      expect(waiterResult).toBe(0);
      await expect(readFinalState(prisma, fixture.bookingId)).resolves.toEqual({
        bookingStatus: BOOKING_PENDING_STATUS,
        paymentStatus: PAYMENT_PENDING_STATUS,
        seatStatuses: [SCREENING_SEAT_BOOKED_STATUS],
      });
    } finally {
      await deleteFixture(prisma, fixture);
    }
  });

  it("does not create a payment when ExpireBooking holds the booking lock first", async () => {
    const fixture = await createFixture(prisma);

    try {
      const outcome = raceOnBookingLock(
        fixture,
        async (tx) => {
          const expired = await bookingRepository.expirePendingBookingWithoutPayment(
            tx,
            fixture.bookingId,
            new Date(),
          );
          if (expired.count !== 1) {
            throw new Error("ExpireBooking should match the pending booking without a payment.");
          }

          await bookingSeatReleaseService.release(tx, fixture.bookingId);
          return expired.count;
        },
        async (tx) => {
          const booking = await bookingRepository.findBookingByIdAndUserId(
            tx,
            fixture.bookingId,
            fixture.userId,
          );
          if (
            !booking ||
            booking.paymentId ||
            booking.status !== BOOKING_PENDING_STATUS ||
            booking.expiresAt.getTime() <= Date.now()
          ) {
            throw new ConflictException("결제할 수 없는 예매입니다.");
          }

          await paymentRepository.createPendingPayment(
            tx,
            fixture.bookingId,
            booking.totalAmount,
            createPaymentOrderId(),
          );
        },
      );

      await expect(outcome).rejects.toBeInstanceOf(ConflictException);
      await expect(readFinalState(prisma, fixture.bookingId)).resolves.toEqual({
        bookingStatus: BOOKING_EXPIRED_STATUS,
        paymentStatus: null,
        seatStatuses: [SCREENING_SEAT_AVAILABLE_STATUS],
      });
    } finally {
      await deleteFixture(prisma, fixture);
    }
  });
});
