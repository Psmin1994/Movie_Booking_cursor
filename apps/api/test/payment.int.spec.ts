/**
 * Test Intent:
 * 기한이 지난 AUTHORIZING Payment를 실제 복구 Use Case가 처리하면 Payment는 RECONCILIATION_REQUIRED, Booking은 CANCELLED, cancelledAt이 기록되고 좌석은 AVAILABLE이 한 트랜잭션으로 맞춰짐을 보장한다. 그 성공은 복구 시각을 시작 시각으로 하고 5분 뒤 처리 시각을 가진 대사 행을 같은 트랜잭션에 남긴다. 같은 Payment에 대사 행이 이미 있으면 복구는 롤백된다. 복구 대상이 아니거나 좌석 반환 건수가 어긋나면 호출 전 상태와 빈 대사 행이 남는다.
 */

import { randomInt, randomUUID } from "node:crypto";
import { jest } from "@jest/globals";
import { INestApplication, InternalServerErrorException } from "@nestjs/common";
import { App } from "supertest/types";
import {
  BOOKING_CANCELLED_STATUS,
  BOOKING_EXPIRED_STATUS,
  BOOKING_PENDING_STATUS,
  SCREENING_SEAT_AVAILABLE_STATUS,
  SCREENING_SEAT_BOOKED_STATUS,
} from "../src/booking/booking.constants.js";
import { PrismaService } from "../src/database/prisma.service.js";
import {
  PAYMENT_AUTHORIZING_STATUS,
  PAYMENT_FAILED_STATUS,
  PAYMENT_RECONCILIATION_REQUIRED_STATUS,
  RECONCILIATION_SCHEDULED_STATUS,
  RECOVER_AUTHORIZING_PAYMENT_RESULT,
} from "../src/payment/payment.constants.js";
import { RecoverAuthorizingPaymentScheduler } from "../src/payment/scheduler/recover-authorizing-payment.scheduler.js";
import { RecoverAuthorizingPaymentService } from "../src/payment/use-case/recover-authorizing-payment.service.js";
import { createTestApp } from "./helpers/create-test-app.js";

jest.setTimeout(30_000);

const idleScheduler = {
  async recoverDueAuthorizingPayments(): Promise<void> {
    return undefined;
  },
};

type Fixture = {
  userId: string;
  movieId: string;
  screenId: string;
  screeningId: string;
  screeningSeatId: string;
  otherScreeningSeatId: string | null;
  bookingId: string;
  paymentId: string;
};

type RowState = {
  paymentStatus: string;
  bookingStatus: string;
  bookedSeatStatus: string;
  otherSeatStatus: string | null;
};

describe("RecoverAuthorizingPaymentService on PostgreSQL", () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let recoverAuthorizingPaymentService: RecoverAuthorizingPaymentService;

  beforeAll(async () => {
    app = await createTestApp((builder) =>
      builder.overrideProvider(RecoverAuthorizingPaymentScheduler).useValue(idleScheduler),
    );
    expect(app.get(RecoverAuthorizingPaymentScheduler)).toBe(idleScheduler);
    prisma = app.get(PrismaService);
    recoverAuthorizingPaymentService = app.get(RecoverAuthorizingPaymentService);
  });

  afterAll(async () => {
    await app.close();
  });

  it("requires reconciliation and releases the booked seat", async () => {
    const fixture = await createFixture(prisma, {
      paymentStatus: PAYMENT_AUTHORIZING_STATUS,
      bookingStatus: BOOKING_PENDING_STATUS,
      authorizationExpiresAt: new Date(Date.now() - 60_000),
      bookedSeatStatus: SCREENING_SEAT_BOOKED_STATUS,
    });

    try {
      const beforeMs = Date.now();
      await expect(recoverAuthorizingPaymentService.execute(fixture.paymentId)).resolves.toEqual({
        result: RECOVER_AUTHORIZING_PAYMENT_RESULT.RECONCILIATION_REQUIRED,
      });
      const afterMs = Date.now();
      await expect(readRows(prisma, fixture)).resolves.toEqual({
        paymentStatus: PAYMENT_RECONCILIATION_REQUIRED_STATUS,
        bookingStatus: BOOKING_CANCELLED_STATUS,
        bookedSeatStatus: SCREENING_SEAT_AVAILABLE_STATUS,
        otherSeatStatus: null,
      });
      const booking = await prisma.client.booking.findUniqueOrThrow({
        where: { id: fixture.bookingId },
        select: { cancelledAt: true },
      });
      expect(booking.cancelledAt).not.toBeNull();
      expect(booking.cancelledAt!.getTime()).toBeGreaterThanOrEqual(beforeMs);
      expect(booking.cancelledAt!.getTime()).toBeLessThanOrEqual(afterMs);
      const reconciliation = await prisma.client.paymentReconciliation.findUniqueOrThrow({
        where: { paymentId: fixture.paymentId },
      });
      expect(reconciliation.createdAt.getTime()).toBeGreaterThanOrEqual(beforeMs);
      expect(reconciliation.createdAt.getTime()).toBeLessThanOrEqual(afterMs);
      expect(reconciliation.status).toBe(RECONCILIATION_SCHEDULED_STATUS);
      expect(reconciliation.result).toBeNull();
      expect(reconciliation.completedAt).toBeNull();
      expect(reconciliation.leaseToken).toBeNull();
      expect(reconciliation.leaseUntil).toBeNull();
      expect(reconciliation.nextProcessAt).toEqual(reconciliation.createdAt);
      expect(reconciliation.retryDeadline).toEqual(
        new Date(reconciliation.createdAt.getTime() + 10 * 60_000),
      );
    } finally {
      await deleteFixture(prisma, fixture);
    }
  });

  it.each([
    {
      name: "the authorization deadline has not passed",
      paymentStatus: PAYMENT_AUTHORIZING_STATUS,
      bookingStatus: BOOKING_PENDING_STATUS,
      authorizationExpiresAt: new Date(Date.now() + 60_000),
    },
    {
      name: "the payment is no longer authorizing",
      paymentStatus: PAYMENT_FAILED_STATUS,
      bookingStatus: BOOKING_PENDING_STATUS,
      authorizationExpiresAt: new Date(Date.now() - 60_000),
    },
    {
      name: "the booking is no longer pending",
      paymentStatus: PAYMENT_AUTHORIZING_STATUS,
      bookingStatus: BOOKING_EXPIRED_STATUS,
      authorizationExpiresAt: new Date(Date.now() - 60_000),
    },
  ])("returns not eligible when $name", async ({ paymentStatus, bookingStatus, authorizationExpiresAt }) => {
    const fixture = await createFixture(prisma, {
      paymentStatus,
      bookingStatus,
      authorizationExpiresAt,
      bookedSeatStatus: SCREENING_SEAT_BOOKED_STATUS,
    });

    try {
      const before = await readRows(prisma, fixture);
      await expect(recoverAuthorizingPaymentService.execute(fixture.paymentId)).resolves.toEqual({
        result: RECOVER_AUTHORIZING_PAYMENT_RESULT.NOT_ELIGIBLE,
      });
      await expect(readRows(prisma, fixture)).resolves.toEqual(before);
      await expect(
        prisma.client.paymentReconciliation.count({ where: { paymentId: fixture.paymentId } }),
      ).resolves.toBe(0);
    } finally {
      await deleteFixture(prisma, fixture);
    }
  });

  it("rolls back payment and booking changes when a booked seat cannot be released", async () => {
    const fixture = await createFixture(prisma, {
      paymentStatus: PAYMENT_AUTHORIZING_STATUS,
      bookingStatus: BOOKING_PENDING_STATUS,
      authorizationExpiresAt: new Date(Date.now() - 60_000),
      bookedSeatStatus: SCREENING_SEAT_BOOKED_STATUS,
      otherSeatStatus: SCREENING_SEAT_AVAILABLE_STATUS,
    });

    try {
      await expect(recoverAuthorizingPaymentService.execute(fixture.paymentId)).rejects.toThrow(
        InternalServerErrorException,
      );
      await expect(readRows(prisma, fixture)).resolves.toEqual({
        paymentStatus: PAYMENT_AUTHORIZING_STATUS,
        bookingStatus: BOOKING_PENDING_STATUS,
        bookedSeatStatus: SCREENING_SEAT_BOOKED_STATUS,
        otherSeatStatus: SCREENING_SEAT_AVAILABLE_STATUS,
      });
      await expect(
        prisma.client.paymentReconciliation.count({ where: { paymentId: fixture.paymentId } }),
      ).resolves.toBe(0);
    } finally {
      await deleteFixture(prisma, fixture);
    }
  });

  it("rolls the recovery back when a reconciliation row already exists", async () => {
    const fixture = await createFixture(prisma, {
      paymentStatus: PAYMENT_AUTHORIZING_STATUS,
      bookingStatus: BOOKING_PENDING_STATUS,
      authorizationExpiresAt: new Date(Date.now() - 60_000),
      bookedSeatStatus: SCREENING_SEAT_BOOKED_STATUS,
    });
    const openedAt = new Date("2026-10-14T00:00:00.000Z");

    try {
      const seeded = await prisma.client.paymentReconciliation.create({
        data: {
          paymentId: fixture.paymentId,
          status: RECONCILIATION_SCHEDULED_STATUS,
          createdAt: openedAt,
          nextProcessAt: openedAt,
          retryDeadline: new Date(openedAt.getTime() + 10 * 60_000),
        },
      });

      await expect(recoverAuthorizingPaymentService.execute(fixture.paymentId)).rejects.toThrow();

      await expect(readRows(prisma, fixture)).resolves.toEqual({
        paymentStatus: PAYMENT_AUTHORIZING_STATUS,
        bookingStatus: BOOKING_PENDING_STATUS,
        bookedSeatStatus: SCREENING_SEAT_BOOKED_STATUS,
        otherSeatStatus: null,
      });
      const reconciliations = await prisma.client.paymentReconciliation.findMany({
        where: { paymentId: fixture.paymentId },
      });
      expect(reconciliations).toHaveLength(1);
      expect(reconciliations[0]?.id).toBe(seeded.id);
      expect(reconciliations[0]?.createdAt).toEqual(openedAt);
    } finally {
      await deleteFixture(prisma, fixture);
    }
  });
});

async function createFixture(
  prisma: PrismaService,
  input: {
    paymentStatus: string;
    bookingStatus: string;
    authorizationExpiresAt: Date;
    bookedSeatStatus: string;
    otherSeatStatus?: string;
  },
): Promise<Fixture> {
  const suffix = randomUUID();
  const user = await prisma.client.user.create({
    data: {
      email: `payment-int-${suffix}@example.com`,
      passwordHash: "test-hash",
      name: "Payment Integration Test",
    },
  });
  const movie = await prisma.client.movie.create({
    data: {
      title: `payment-int-${suffix}`,
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
      row: "Z",
      number: 1,
      seatType: "STANDARD",
    },
  });
  const screeningSeat = await prisma.client.screeningSeat.create({
    data: {
      screeningId: screening.id,
      seatId: seat.id,
      status: input.bookedSeatStatus,
    },
  });
  const booking = await prisma.client.booking.create({
    data: {
      userId: user.id,
      screeningId: screening.id,
      status: input.bookingStatus,
      totalAmount: 1000,
      expiresAt: new Date(Date.now() + 60_000),
    },
  });
  await prisma.client.bookingSeat.create({
    data: {
      bookingId: booking.id,
      screeningSeatId: screeningSeat.id,
    },
  });
  let otherScreeningSeatId: string | null = null;
  if (input.otherSeatStatus) {
    const otherSeat = await prisma.client.seat.create({
      data: {
        screenId: screen.id,
        row: "Z",
        number: 2,
        seatType: "STANDARD",
      },
    });
    const otherScreeningSeat = await prisma.client.screeningSeat.create({
      data: {
        screeningId: screening.id,
        seatId: otherSeat.id,
        status: input.otherSeatStatus,
      },
    });
    otherScreeningSeatId = otherScreeningSeat.id;
    await prisma.client.bookingSeat.create({
      data: {
        bookingId: booking.id,
        screeningSeatId: otherScreeningSeat.id,
      },
    });
  }
  const payment = await prisma.client.payment.create({
    data: {
      bookingId: booking.id,
      orderId: `ord_${suffix}`,
      paymentKey: `pay_${suffix}`,
      status: input.paymentStatus,
      amount: 1000,
      authorizationExpiresAt: input.authorizationExpiresAt,
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
  };
}

async function readRows(prisma: PrismaService, fixture: Fixture): Promise<RowState> {
  const payment = await prisma.client.payment.findUniqueOrThrow({
    where: { id: fixture.paymentId },
    select: { status: true },
  });
  const booking = await prisma.client.booking.findUniqueOrThrow({
    where: { id: fixture.bookingId },
    select: { status: true },
  });
  const bookedSeat = await prisma.client.screeningSeat.findUniqueOrThrow({
    where: { id: fixture.screeningSeatId },
    select: { status: true },
  });
  const otherSeat = fixture.otherScreeningSeatId
    ? await prisma.client.screeningSeat.findUniqueOrThrow({
        where: { id: fixture.otherScreeningSeatId },
        select: { status: true },
      })
    : null;

  return {
    paymentStatus: payment.status,
    bookingStatus: booking.status,
    bookedSeatStatus: bookedSeat.status,
    otherSeatStatus: otherSeat?.status ?? null,
  };
}

async function deleteFixture(prisma: PrismaService, fixture: Fixture) {
  await prisma.client.paymentReconciliation.deleteMany({ where: { paymentId: fixture.paymentId } });
  await prisma.client.payment.deleteMany({ where: { bookingId: fixture.bookingId } });
  await prisma.client.bookingSeat.deleteMany({ where: { bookingId: fixture.bookingId } });
  await prisma.client.booking.delete({ where: { id: fixture.bookingId } });
  await prisma.client.screeningSeat.deleteMany({ where: { screeningId: fixture.screeningId } });
  await prisma.client.seat.deleteMany({ where: { screenId: fixture.screenId } });
  await prisma.client.screening.delete({ where: { id: fixture.screeningId } });
  await prisma.client.screen.delete({ where: { id: fixture.screenId } });
  await prisma.client.movie.delete({ where: { id: fixture.movieId } });
  await prisma.client.user.delete({ where: { id: fixture.userId } });
}
