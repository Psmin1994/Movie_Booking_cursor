/**
 * Test Intent:
 * 좌석 해제 건수가 예매 좌석 수와 다르면 그 호출자의 트랜잭션이 롤백되어 Booking, Payment, Refund, 좌석이 호출 전 상태로 남음을 보장한다.
 * 승인 복구 Use Case의 롤백은 payment.int.spec.ts가 담당한다.
 */

import { randomInt, randomUUID } from "node:crypto";
import { jest } from "@jest/globals";
import { INestApplication, InternalServerErrorException } from "@nestjs/common";
import { App } from "supertest/types";
import type { AuthenticatedUser } from "../src/auth/decorators/current-user.decorator.js";
import {
  BOOKING_CONFIRMED_STATUS,
  BOOKING_PENDING_STATUS,
} from "../src/booking/booking.constants.js";
import { CancelBookingService } from "../src/booking/use-case/cancel-booking.service.js";
import { ExpireBookingScheduler } from "../src/booking/scheduler/expire-booking.scheduler.js";
import { ExpireBookingService } from "../src/booking/use-case/expire-booking.service.js";
import { PrismaService } from "../src/database/prisma.service.js";
import {
  PAYMENT_AUTHORIZING_STATUS,
  PAYMENT_PAID_STATUS,
  PAYMENT_PENDING_STATUS,
} from "../src/payment/payment.constants.js";
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
import { ExpirePaymentScheduler } from "../src/payment/scheduler/expire-payment.scheduler.js";
import { RecoverAuthorizingPaymentScheduler } from "../src/payment/scheduler/recover-authorizing-payment.scheduler.js";
import { ExpirePaymentService } from "../src/payment/use-case/expire-payment.service.js";
import { PaymentService } from "../src/payment/use-case/payment.service.js";
import {
  SCREENING_SEAT_AVAILABLE_STATUS,
  SCREENING_SEAT_BOOKED_STATUS,
} from "../src/screening/screening.constants.js";
import { createTestApp } from "./helpers/create-test-app.js";

jest.setTimeout(45_000);

class MismatchPaymentGateway extends PaymentGateway {
  mode: "FAILED" | "UNKNOWN" = "FAILED";

  confirm(_input: PaymentGatewayConfirmInput): Promise<PaymentGatewayConfirmResult> {
    if (this.mode === "FAILED") {
      return Promise.resolve({ status: "FAILED" });
    }

    return Promise.resolve({ status: "UNKNOWN" });
  }

  retrieve(_input: PaymentGatewayRetrieveInput): Promise<PaymentGatewayConfirmResult> {
    return Promise.resolve({ status: "UNKNOWN" });
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

const idleScheduler = {
  async expireDueBookings(): Promise<void> {
    return undefined;
  },
  async expireDuePayments(): Promise<void> {
    return undefined;
  },
  async recoverDueAuthorizingPayments(): Promise<void> {
    return undefined;
  },
};

type Fixture = {
  userId: string;
  email: string;
  movieId: string;
  screenId: string;
  screeningId: string;
  screeningSeatId: string;
  otherScreeningSeatId: string;
  bookingId: string;
  paymentId: string | null;
};

type RowState = {
  bookingStatus: string;
  paymentStatus: string | null;
  refundCount: number;
  bookedSeatStatus: string;
  otherSeatStatus: string;
};

describe("Seat release mismatch rollback on PostgreSQL", () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let expireBookingService: ExpireBookingService;
  let expirePaymentService: ExpirePaymentService;
  let cancelBookingService: CancelBookingService;
  let paymentService: PaymentService;
  const paymentGateway = new MismatchPaymentGateway();

  beforeAll(async () => {
    app = await createTestApp((builder) =>
      builder
        .overrideProvider(PaymentGateway)
        .useValue(paymentGateway)
        .overrideProvider(ExpireBookingScheduler)
        .useValue(idleScheduler)
        .overrideProvider(ExpirePaymentScheduler)
        .useValue(idleScheduler)
        .overrideProvider(RecoverAuthorizingPaymentScheduler)
        .useValue(idleScheduler),
    );
    prisma = app.get(PrismaService);
    expireBookingService = app.get(ExpireBookingService);
    expirePaymentService = app.get(ExpirePaymentService);
    cancelBookingService = app.get(CancelBookingService);
    paymentService = app.get(PaymentService);
  });

  afterAll(async () => {
    await app.close();
  });

  it("rolls back booking expiry when a booked seat cannot be released", async () => {
    const fixture = await createFixture(prisma, {
      bookingStatus: BOOKING_PENDING_STATUS,
      expiresAt: new Date(Date.now() - 60_000),
      payment: null,
    });

    try {
      const before = await readRows(prisma, fixture);
      await expect(expireBookingService.execute(fixture.bookingId)).rejects.toThrow(
        InternalServerErrorException,
      );
      await expect(readRows(prisma, fixture)).resolves.toEqual(before);
    } finally {
      await deleteFixture(prisma, fixture);
    }
  });

  it("rolls back payment and booking expiry when a booked seat cannot be released", async () => {
    const fixture = await createFixture(prisma, {
      bookingStatus: BOOKING_PENDING_STATUS,
      expiresAt: new Date(Date.now() - 60_000),
      payment: { status: PAYMENT_PENDING_STATUS },
    });

    try {
      const before = await readRows(prisma, fixture);
      await expect(expirePaymentService.execute(fixture.paymentId ?? "")).rejects.toThrow(
        InternalServerErrorException,
      );
      await expect(readRows(prisma, fixture)).resolves.toEqual(before);
    } finally {
      await deleteFixture(prisma, fixture);
    }
  });

  it("rolls back a pending cancellation when a booked seat cannot be released", async () => {
    const fixture = await createFixture(prisma, {
      bookingStatus: BOOKING_PENDING_STATUS,
      expiresAt: new Date(Date.now() + 60_000),
      payment: { status: PAYMENT_PENDING_STATUS },
    });

    try {
      const before = await readRows(prisma, fixture);
      await expect(cancelBookingService.cancelPending(userOf(fixture), fixture.bookingId)).rejects.toThrow(
        InternalServerErrorException,
      );
      await expect(readRows(prisma, fixture)).resolves.toEqual(before);
    } finally {
      await deleteFixture(prisma, fixture);
    }
  });

  it("rolls back a confirmed cancellation and does not leave a refund when a booked seat cannot be released", async () => {
    const fixture = await createFixture(prisma, {
      bookingStatus: BOOKING_CONFIRMED_STATUS,
      expiresAt: new Date(Date.now() - 60_000),
      payment: { status: PAYMENT_PAID_STATUS },
    });

    try {
      const before = await readRows(prisma, fixture);
      await expect(cancelBookingService.cancelConfirmed(userOf(fixture), fixture.bookingId)).rejects.toThrow(
        InternalServerErrorException,
      );
      await expect(readRows(prisma, fixture)).resolves.toEqual(before);
      expect(before.refundCount).toBe(0);
    } finally {
      await deleteFixture(prisma, fixture);
    }
  });

  it("rolls back payment failure after authorization when a booked seat cannot be released", async () => {
    const fixture = await createFixture(prisma, {
      bookingStatus: BOOKING_PENDING_STATUS,
      expiresAt: new Date(Date.now() + 60_000),
      payment: { status: PAYMENT_PENDING_STATUS },
    });
    paymentGateway.mode = "FAILED";

    try {
      const before = await readRows(prisma, fixture);
      await expect(
        paymentService.pay(userOf(fixture), fixture.paymentId ?? "", `pay_${randomUUID()}`),
      ).rejects.toThrow(InternalServerErrorException);
      await expect(readRows(prisma, fixture)).resolves.toEqual({
        ...before,
        paymentStatus: PAYMENT_AUTHORIZING_STATUS,
      });
    } finally {
      await deleteFixture(prisma, fixture);
    }
  });

  it("rolls back hold expiry inside payment authorization when a booked seat cannot be released", async () => {
    const fixture = await createFixture(prisma, {
      bookingStatus: BOOKING_PENDING_STATUS,
      expiresAt: new Date(Date.now() - 60_000),
      payment: { status: PAYMENT_PENDING_STATUS },
    });

    try {
      const before = await readRows(prisma, fixture);
      await expect(
        paymentService.pay(userOf(fixture), fixture.paymentId ?? "", `pay_${randomUUID()}`),
      ).rejects.toThrow(InternalServerErrorException);
      await expect(readRows(prisma, fixture)).resolves.toEqual(before);
    } finally {
      await deleteFixture(prisma, fixture);
    }
  });

  it("rolls back reconciliation after authorization when a booked seat cannot be released", async () => {
    const fixture = await createFixture(prisma, {
      bookingStatus: BOOKING_PENDING_STATUS,
      expiresAt: new Date(Date.now() + 60_000),
      payment: { status: PAYMENT_PENDING_STATUS },
    });
    paymentGateway.mode = "UNKNOWN";

    try {
      const before = await readRows(prisma, fixture);
      await expect(
        paymentService.pay(userOf(fixture), fixture.paymentId ?? "", `pay_${randomUUID()}`),
      ).rejects.toThrow(InternalServerErrorException);
      await expect(readRows(prisma, fixture)).resolves.toEqual({
        ...before,
        paymentStatus: PAYMENT_AUTHORIZING_STATUS,
      });
    } finally {
      await deleteFixture(prisma, fixture);
    }
  });
});

function userOf(fixture: Fixture): AuthenticatedUser {
  return { id: fixture.userId, email: fixture.email };
}

async function createFixture(
  prisma: PrismaService,
  input: {
    bookingStatus: string;
    expiresAt: Date;
    payment: { status: string } | null;
  },
): Promise<Fixture> {
  const suffix = randomUUID();
  const email = `seat-release-rollback-${suffix}@example.com`;
  const user = await prisma.client.user.create({
    data: {
      email,
      passwordHash: "test-hash",
      name: "Seat Release Rollback",
    },
  });
  const movie = await prisma.client.movie.create({
    data: {
      title: `seat-release-rollback-${suffix}`,
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
    data: { screenId: screen.id, row: "Z", number: 1, seatType: "STANDARD" },
  });
  const otherSeat = await prisma.client.seat.create({
    data: { screenId: screen.id, row: "Z", number: 2, seatType: "STANDARD" },
  });
  const screeningSeat = await prisma.client.screeningSeat.create({
    data: {
      screeningId: screening.id,
      seatId: seat.id,
      status: SCREENING_SEAT_BOOKED_STATUS,
    },
  });
  const otherScreeningSeat = await prisma.client.screeningSeat.create({
    data: {
      screeningId: screening.id,
      seatId: otherSeat.id,
      status: SCREENING_SEAT_AVAILABLE_STATUS,
    },
  });
  const booking = await prisma.client.booking.create({
    data: {
      userId: user.id,
      screeningId: screening.id,
      status: input.bookingStatus,
      totalAmount: 1000,
      expiresAt: input.expiresAt,
    },
  });
  await prisma.client.bookingSeat.createMany({
    data: [
      { bookingId: booking.id, screeningSeatId: screeningSeat.id },
      { bookingId: booking.id, screeningSeatId: otherScreeningSeat.id },
    ],
  });
  const payment = input.payment
    ? await prisma.client.payment.create({
        data: {
          bookingId: booking.id,
          orderId: `ord_${suffix}`,
          status: input.payment.status,
          amount: 1000,
        },
      })
    : null;

  return {
    userId: user.id,
    email,
    movieId: movie.id,
    screenId: screen.id,
    screeningId: screening.id,
    screeningSeatId: screeningSeat.id,
    otherScreeningSeatId: otherScreeningSeat.id,
    bookingId: booking.id,
    paymentId: payment?.id ?? null,
  };
}

async function readRows(prisma: PrismaService, fixture: Fixture): Promise<RowState> {
  const booking = await prisma.client.booking.findUniqueOrThrow({
    where: { id: fixture.bookingId },
    select: { status: true },
  });
  const payment = fixture.paymentId
    ? await prisma.client.payment.findUniqueOrThrow({
        where: { id: fixture.paymentId },
        select: { status: true },
      })
    : null;
  const refundCount = fixture.paymentId
    ? await prisma.client.refund.count({ where: { paymentId: fixture.paymentId } })
    : 0;
  const bookedSeat = await prisma.client.screeningSeat.findUniqueOrThrow({
    where: { id: fixture.screeningSeatId },
    select: { status: true },
  });
  const otherSeat = await prisma.client.screeningSeat.findUniqueOrThrow({
    where: { id: fixture.otherScreeningSeatId },
    select: { status: true },
  });

  return {
    bookingStatus: booking.status,
    paymentStatus: payment?.status ?? null,
    refundCount,
    bookedSeatStatus: bookedSeat.status,
    otherSeatStatus: otherSeat.status,
  };
}

async function deleteFixture(prisma: PrismaService, fixture: Fixture) {
  if (fixture.paymentId) {
    await prisma.client.refund.deleteMany({ where: { paymentId: fixture.paymentId } });
    await prisma.client.payment.deleteMany({ where: { id: fixture.paymentId } });
  }
  await prisma.client.bookingSeat.deleteMany({ where: { bookingId: fixture.bookingId } });
  await prisma.client.booking.delete({ where: { id: fixture.bookingId } });
  await prisma.client.screeningSeat.deleteMany({ where: { screeningId: fixture.screeningId } });
  await prisma.client.seat.deleteMany({ where: { screenId: fixture.screenId } });
  await prisma.client.screening.delete({ where: { id: fixture.screeningId } });
  await prisma.client.screen.delete({ where: { id: fixture.screenId } });
  await prisma.client.movie.delete({ where: { id: fixture.movieId } });
  await prisma.client.user.delete({ where: { id: fixture.userId } });
}
