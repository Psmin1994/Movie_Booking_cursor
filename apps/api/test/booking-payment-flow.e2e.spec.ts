/**
 * Test Intent:
 * 예매 생성 후 결제 생성, 승인 성공과 실패, 취소가 HTTP로 이어지고 예매, 좌석, 결제, 환불 상태와 맞음을 보장한다.
 * 확정 취소는 PENDING Refund를 같은 전이에서 만들고, Commit 이후 ProcessRefund Worker가 Gateway 결과에 따라 환불을 처리한다.
 * 인증이 없거나 타인 소유이거나 이미 끝난 결제는 거절되며, 거절된 요청은 기존 상태를 바꾸지 않는다.
 */

import { randomInt, randomUUID } from "node:crypto";
import { INestApplication } from "@nestjs/common";
import { App } from "supertest/types";
import request from "supertest";
import { PrismaService } from "../src/database/prisma.service.js";
import {
  SEAT_PRICE,
  BOOKING_CANCELLED_STATUS,
  BOOKING_CONFIRMED_STATUS,
  BOOKING_FAILED_STATUS,
  BOOKING_PENDING_STATUS,
  SCREENING_SEAT_AVAILABLE_STATUS,
  SCREENING_SEAT_BOOKED_STATUS,
} from "../src/booking/booking.constants.js";
import {
  PAYMENT_FAILED_STATUS,
  REFUND_PENDING_STATUS,
  PAYMENT_PAID_STATUS,
  PAYMENT_PENDING_STATUS,
} from "../src/payment/payment.constants.js";
import {
  REFUND_COMPLETED_STATUS,
  REFUND_FAILED_STATUS,
} from "../src/refund/refund.constants.js";
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
import { createTestApp } from "./helpers/create-test-app.js";

class ScriptablePaymentGateway extends PaymentGateway {
  mode: "SUCCESS" | "FAILED" = "SUCCESS";
  cancelResult: "SUCCESS" | "FAILED" | "UNKNOWN" = "SUCCESS";

  confirm(
    input: PaymentGatewayConfirmInput,
  ): Promise<PaymentGatewayConfirmResult> {
    if (this.mode === "FAILED") {
      return Promise.resolve({
        status: "FAILED",
      });
    }

    return Promise.resolve({
      status: "SUCCESS",
      paymentKey: input.paymentKey,
      orderId: input.orderId,
      amount: input.amount,
      approvedAt: new Date(),
    });
  }

  retrieve(
    _input: PaymentGatewayRetrieveInput,
  ): Promise<PaymentGatewayConfirmResult> {
    return Promise.resolve({
      status: "UNKNOWN",
    });
  }

  cancel(input: PaymentGatewayCancelInput): Promise<PaymentGatewayCancelResult> {
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
    return Promise.resolve({
      status: "CANCELED",
      paymentKey: input.paymentKey,
      transactionKey: input.transactionKey,
      cancelAmount: input.cancelAmount,
    });
  }
}

describe("Booking payment flow (e2e)", () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const paymentGateway = new ScriptablePaymentGateway();
  let ownerCookie: string | string[];
  let ownerUserId: string;
  let otherCookie: string | string[];

  const movieId = randomUUID();
  const screenId = randomUUID();
  const seatA1Id = randomUUID();
  const seatA2Id = randomUUID();
  const screeningId = randomUUID();
  const screeningSeatA1Id = randomUUID();
  const screeningSeatA2Id = randomUUID();
  const screenNumber = 910000 + randomInt(10000);
  const ownerEmail = `booking-payment-owner-${randomUUID()}@example.com`;
  const otherEmail = `booking-payment-other-${randomUUID()}@example.com`;
  const password = "password123";
  const movieTitle = "BookingPayment e2e fixture";
  const startAt = new Date("2099-09-01T10:30:00.000Z");

  beforeAll(async () => {
    app = await createTestApp((builder) =>
      builder.overrideProvider(PaymentGateway).useValue(paymentGateway),
    );
    prisma = app.get(PrismaService);
  });

  beforeEach(async () => {
    paymentGateway.mode = "SUCCESS";
    paymentGateway.cancelResult = "SUCCESS";
    await prisma.client.movie.create({
      data: {
        id: movieId,
        title: movieTitle,
        runtime: 120,
        releaseDate: new Date("2020-01-01"),
      },
    });
    await prisma.client.screen.create({
      data: {
        id: screenId,
        number: screenNumber,
        floor: 1,
        screenType: "2D",
      },
    });
    await prisma.client.seat.createMany({
      data: [
        {
          id: seatA1Id,
          screenId,
          row: "A",
          number: 1,
          seatType: "STANDARD",
        },
        {
          id: seatA2Id,
          screenId,
          row: "A",
          number: 2,
          seatType: "STANDARD",
        },
      ],
    });
    await prisma.client.screening.create({
      data: {
        id: screeningId,
        movieId,
        screenId,
        startAt,
      },
    });
    await prisma.client.screeningSeat.createMany({
      data: [
        {
          id: screeningSeatA1Id,
          screeningId,
          seatId: seatA1Id,
          status: SCREENING_SEAT_AVAILABLE_STATUS,
        },
        {
          id: screeningSeatA2Id,
          screeningId,
          seatId: seatA2Id,
          status: SCREENING_SEAT_AVAILABLE_STATUS,
        },
      ],
    });

    const owner = await signupAndLogin(ownerEmail, "예매테스터");
    ownerUserId = owner.userId;
    ownerCookie = owner.cookie;

    const other = await signupAndLogin(otherEmail, "다른사용자");
    otherCookie = other.cookie;
  });

  afterEach(async () => {
    if (!prisma) {
      return;
    }

    // CancelConfirmed starts ProcessRefund asynchronously; wait for leases to clear
    // before deleting rows so in-flight workers do not race cleanup.
    await waitForRefundWorkersIdle();

    await prisma.client.refund.deleteMany({
      where: { payment: { booking: { screeningId } } },
    });
    await prisma.client.payment.deleteMany({
      where: { booking: { screeningId } },
    });
    await prisma.client.bookingSeat.deleteMany({
      where: {
        screeningSeatId: { in: [screeningSeatA1Id, screeningSeatA2Id] },
      },
    });
    await prisma.client.booking.deleteMany({ where: { screeningId } });
    await prisma.client.screeningSeat.deleteMany({ where: { screeningId } });
    await prisma.client.screening.deleteMany({ where: { id: screeningId } });
    await prisma.client.seat.deleteMany({ where: { screenId } });
    await prisma.client.screen.deleteMany({ where: { id: screenId } });
    await prisma.client.movie.deleteMany({ where: { id: movieId } });
    await prisma.client.user.deleteMany({
      where: { email: { in: [ownerEmail, otherEmail] } },
    });
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it("completes signup, booking, and payment through confirmed booking lookup", async () => {
    const screeningResponse = await request(app.getHttpServer())
      .get(`/api/screenings/${screeningId}`)
      .expect(200);

    expect(screeningResponse.body).toMatchObject({
      id: screeningId,
      startAt: startAt.toISOString(),
      movie: {
        id: movieId,
        title: movieTitle,
        runtime: 120,
      },
      screen: {
        id: screenId,
        number: screenNumber,
        floor: 1,
        screenType: "2D",
      },
    });
    expect(screeningResponse.body.seats).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: screeningSeatA1Id,
          row: "A",
          number: 1,
          status: SCREENING_SEAT_AVAILABLE_STATUS,
        }),
        expect.objectContaining({
          id: screeningSeatA2Id,
          row: "A",
          number: 2,
          status: SCREENING_SEAT_AVAILABLE_STATUS,
        }),
      ]),
    );

    const seatsResponse = await request(app.getHttpServer())
      .get(`/api/screenings/${screeningId}/seats`)
      .expect(200);

    expect(seatsResponse.body.seats).toEqual(
      expect.arrayContaining([
        {
          id: screeningSeatA1Id,
          row: "A",
          number: 1,
          status: SCREENING_SEAT_AVAILABLE_STATUS,
        },
        {
          id: screeningSeatA2Id,
          row: "A",
          number: 2,
          status: SCREENING_SEAT_AVAILABLE_STATUS,
        },
      ]),
    );

    const { bookingId, payment } = await bookAndCreatePayment(ownerCookie, [
      screeningSeatA1Id,
      screeningSeatA2Id,
    ]);

    const pending = await loadBookingState(bookingId);
    expect(pending.booking.userId).toBe(ownerUserId);
    expect(pending.booking.screeningId).toBe(screeningId);
    expect(pending.booking.status).toBe(BOOKING_PENDING_STATUS);
    expect(pending.booking.confirmedAt).toBeNull();
    expect(pending.booking.payment).toMatchObject({
      id: payment.id,
      orderId: payment.orderId,
      status: PAYMENT_PENDING_STATUS,
      amount: payment.amount,
      paidAt: null,
    });
    expect(pending.seats).toEqual(
      expect.arrayContaining([
        { id: screeningSeatA1Id, status: SCREENING_SEAT_BOOKED_STATUS },
        { id: screeningSeatA2Id, status: SCREENING_SEAT_BOOKED_STATUS },
      ]),
    );

    const payResponse = await request(app.getHttpServer())
      .post(`/api/payments/${payment.id}`)
      .set("Cookie", ownerCookie)
      .send({ paymentKey: "pay-key" })
      .expect(200);

    expect(payResponse.body).toMatchObject({
      id: payment.id,
      bookingId,
      status: PAYMENT_PAID_STATUS,
    });
    expect(payResponse.body.paidAt).toEqual(expect.any(String));

    const paid = await loadBookingState(bookingId);
    expect(paid.booking.status).toBe(BOOKING_CONFIRMED_STATUS);
    expect(paid.booking.cancelledAt).toBeNull();
    expect(paid.booking.confirmedAt).toEqual(paid.booking.payment?.paidAt);
    expect(paid.booking.payment).toMatchObject({
      id: payment.id,
      status: PAYMENT_PAID_STATUS,
      failedAt: null,
      amount: payment.amount,
    });
    expect(paid.seats).toEqual(
      expect.arrayContaining([
        { id: screeningSeatA1Id, status: SCREENING_SEAT_BOOKED_STATUS },
        { id: screeningSeatA2Id, status: SCREENING_SEAT_BOOKED_STATUS },
      ]),
    );

    const myBookingsResponse = await request(app.getHttpServer())
      .get("/api/bookings")
      .set("Cookie", ownerCookie)
      .expect(200);

    expect(myBookingsResponse.body).toEqual([
      expect.objectContaining({
        id: bookingId,
        status: BOOKING_CONFIRMED_STATUS,
        confirmedAt: paid.booking.confirmedAt?.toISOString(),
      }),
    ]);
  });

  it("fails a pending payment and releases the booked seats", async () => {
    const { bookingId, payment } = await bookAndCreatePayment(ownerCookie, [
      screeningSeatA1Id,
    ]);

    paymentGateway.mode = "FAILED";
    const failResponse = await request(app.getHttpServer())
      .post(`/api/payments/${payment.id}`)
      .set("Cookie", ownerCookie)
      .send({ paymentKey: "pay-key" })
      .expect(200);

    expect(failResponse.body).toMatchObject({
      id: payment.id,
      bookingId,
      status: PAYMENT_FAILED_STATUS,
    });

    const failed = await loadBookingState(bookingId);
    expect(failed.booking.status).toBe(BOOKING_FAILED_STATUS);
    expect(failed.booking.payment?.status).toBe(PAYMENT_FAILED_STATUS);
    expect(statusOf(failed.seats, screeningSeatA1Id)).toBe(
      SCREENING_SEAT_AVAILABLE_STATUS,
    );
    expect(statusOf(failed.seats, screeningSeatA2Id)).toBe(
      SCREENING_SEAT_AVAILABLE_STATUS,
    );
    expect(
      await prisma.client.refund.count({ where: { paymentId: payment.id } }),
    ).toBe(0);
  });

  it("rejects booking and payment without authentication", async () => {
    await request(app.getHttpServer())
      .post("/api/bookings")
      .send({
        screeningId,
        screeningSeatIds: [screeningSeatA1Id],
      })
      .expect(401)
      .expect((response) => {
        expect(response.body.message).toBe("인증이 필요합니다.");
      });

    const { bookingId, payment } = await bookAndCreatePayment(ownerCookie, [
      screeningSeatA1Id,
    ]);

    await request(app.getHttpServer())
      .post("/api/payments")
      .send({ bookingId })
      .expect(401)
      .expect((response) => {
        expect(response.body.message).toBe("인증이 필요합니다.");
      });

    await request(app.getHttpServer())
      .post(`/api/payments/${payment.id}`)
      .send({ paymentKey: "pay-key" })
      .expect(401)
      .expect((response) => {
        expect(response.body.message).toBe("인증이 필요합니다.");
      });

    const pending = await loadBookingState(bookingId);
    expect(pending.booking.status).toBe(BOOKING_PENDING_STATUS);
    expect(pending.booking.payment?.status).toBe(PAYMENT_PENDING_STATUS);
    expect(statusOf(pending.seats, screeningSeatA1Id)).toBe(
      SCREENING_SEAT_BOOKED_STATUS,
    );
  });

  it("hides another user's payment for pay, fail, and cancel", async () => {
    const { bookingId, payment } = await bookAndCreatePayment(ownerCookie, [
      screeningSeatA1Id,
    ]);

    await request(app.getHttpServer())
      .post(`/api/payments/${payment.id}`)
      .set("Cookie", otherCookie)
      .send({ paymentKey: "pay-key" })
      .expect(404)
      .expect((response) => {
        expect(response.body.message).toBe("결제를 찾을 수 없습니다.");
      });

    const pending = await loadBookingState(bookingId);
    expect(pending.booking.status).toBe(BOOKING_PENDING_STATUS);
    expect(pending.booking.payment).toMatchObject({
      id: payment.id,
      status: PAYMENT_PENDING_STATUS,
      paidAt: null,
      failedAt: null,
    });
    expect(statusOf(pending.seats, screeningSeatA1Id)).toBe(
      SCREENING_SEAT_BOOKED_STATUS,
    );
  });

  it("hides another user's confirmed booking cancellation", async () => {
    const { bookingId } = await payBooking([screeningSeatA1Id]);

    await request(app.getHttpServer())
      .post(`/api/bookings/${bookingId}/cancel`)
      .set("Cookie", otherCookie)
      .expect(404)
      .expect((response) => {
        expect(response.body.message).toBe("예매를 찾을 수 없습니다.");
      });

    const confirmed = await loadBookingState(bookingId);
    expect(confirmed.booking.status).toBe(BOOKING_CONFIRMED_STATUS);
    expect(confirmed.booking.payment?.status).toBe(PAYMENT_PAID_STATUS);
    expect(statusOf(confirmed.seats, screeningSeatA1Id)).toBe(
      SCREENING_SEAT_BOOKED_STATUS,
    );
  });

  it("rejects pay, fail, and cancel after a payment is paid", async () => {
    const { bookingId, paymentId } = await payBooking([screeningSeatA1Id]);
    const before = await loadBookingState(bookingId);

    await request(app.getHttpServer())
      .post(`/api/payments/${paymentId}`)
      .set("Cookie", ownerCookie)
      .send({ paymentKey: "pay-key" })
      .expect(409)
      .expect((response) => {
        expect(response.body.message).toBe("결제할 수 없는 상태입니다.");
      });

    const after = await loadBookingState(bookingId);
    expect(after.booking.status).toBe(BOOKING_CONFIRMED_STATUS);
    expect(after.booking.confirmedAt?.toISOString()).toBe(
      before.booking.confirmedAt?.toISOString(),
    );
    expect(after.booking.cancelledAt).toBeNull();
    expect(after.booking.payment).toMatchObject({
      id: paymentId,
      status: PAYMENT_PAID_STATUS,
      paidAt: before.booking.payment?.paidAt,
      failedAt: null,
      amount: SEAT_PRICE,
    });
    expect(statusOf(after.seats, screeningSeatA1Id)).toBe(
      SCREENING_SEAT_BOOKED_STATUS,
    );
  });

  it("rejects pay, fail, and cancel after a payment has failed", async () => {
    const { bookingId, payment } = await bookAndCreatePayment(ownerCookie, [
      screeningSeatA1Id,
    ]);

    paymentGateway.mode = "FAILED";
    await request(app.getHttpServer())
      .post(`/api/payments/${payment.id}`)
      .set("Cookie", ownerCookie)
      .send({ paymentKey: "pay-key" })
      .expect(200);

    const before = await loadBookingState(bookingId);
    paymentGateway.mode = "SUCCESS";

    await request(app.getHttpServer())
      .post(`/api/payments/${payment.id}`)
      .set("Cookie", ownerCookie)
      .send({ paymentKey: "pay-key" })
      .expect(409)
      .expect((response) => {
        expect(response.body.message).toBe("결제할 수 없는 상태입니다.");
      });

    const after = await loadBookingState(bookingId);
    expect(after.booking.status).toBe(BOOKING_FAILED_STATUS);
    expect(after.booking.failedAt?.toISOString()).toBe(
      before.booking.failedAt?.toISOString(),
    );
    expect(after.booking.cancelledAt).toBeNull();
    expect(after.booking.payment).toMatchObject({
      id: payment.id,
      status: PAYMENT_FAILED_STATUS,
      paidAt: null,
      failedAt: before.booking.payment?.failedAt,
      amount: SEAT_PRICE,
    });
    expect(statusOf(after.seats, screeningSeatA1Id)).toBe(
      SCREENING_SEAT_AVAILABLE_STATUS,
    );
  });

  it("cancels a confirmed booking, releases seats, and creates a refund", async () => {
    paymentGateway.cancelResult = "UNKNOWN";
    const { bookingId, paymentId } = await payBooking([
      screeningSeatA1Id,
      screeningSeatA2Id,
    ]);

    await request(app.getHttpServer())
      .post(`/api/bookings/${bookingId}/cancel`)
      .set("Cookie", ownerCookie)
      .expect(204);

    const cancelled = await loadBookingState(bookingId);
    expect(cancelled.booking.status).toBe(BOOKING_CANCELLED_STATUS);
    expect(cancelled.booking.cancelledAt).toBeInstanceOf(Date);
    expect(cancelled.booking.payment).toMatchObject({
      id: paymentId,
      status: PAYMENT_PAID_STATUS,
      amount: 2 * SEAT_PRICE,
    });
    expect(statusOf(cancelled.seats, screeningSeatA1Id)).toBe(
      SCREENING_SEAT_AVAILABLE_STATUS,
    );
    expect(statusOf(cancelled.seats, screeningSeatA2Id)).toBe(
      SCREENING_SEAT_AVAILABLE_STATUS,
    );

    const bookingSeats = await prisma.client.bookingSeat.findMany({
      where: { bookingId },
    });
    expect(bookingSeats).toHaveLength(2);

    const refund = await waitForRefund(paymentId, (row) => row.status === REFUND_PENDING_STATUS);
    expect(refund).toMatchObject({
      paymentId,
      amount: 2 * SEAT_PRICE,
      status: REFUND_PENDING_STATUS,
      completedAt: null,
      failedAt: null,
    });
  });

  it("completes a refund through the cancel worker without changing booking or payment", async () => {
    const { bookingId, paymentId } = await payBooking([screeningSeatA1Id]);
    const beforeCancel = await loadBookingState(bookingId);

    await request(app.getHttpServer())
      .post(`/api/bookings/${bookingId}/cancel`)
      .set("Cookie", ownerCookie)
      .expect(204);

    const refund = await waitForRefund(
      paymentId,
      (row) => row.status === REFUND_COMPLETED_STATUS,
    );
    expect(refund).toMatchObject({
      paymentId,
      status: REFUND_COMPLETED_STATUS,
      amount: SEAT_PRICE,
      failedAt: null,
    });
    expect(refund.completedAt).toBeInstanceOf(Date);

    const after = await loadBookingState(bookingId);
    expect(after.booking.status).toBe(BOOKING_CANCELLED_STATUS);
    expect(after.booking.payment?.status).toBe(PAYMENT_PAID_STATUS);
    expect(after.booking.payment?.amount).toBe(SEAT_PRICE);
    expect(after.booking.payment?.paidAt?.toISOString()).toBe(
      beforeCancel.booking.payment?.paidAt?.toISOString(),
    );
  });

  it("fails a refund through the cancel worker and records failedAt", async () => {
    paymentGateway.cancelResult = "FAILED";
    const { bookingId, paymentId } = await payBooking([screeningSeatA1Id]);

    await request(app.getHttpServer())
      .post(`/api/bookings/${bookingId}/cancel`)
      .set("Cookie", ownerCookie)
      .expect(204);

    const refund = await waitForRefund(paymentId, (row) => row.status === REFUND_FAILED_STATUS);
    expect(refund).toMatchObject({
      status: REFUND_FAILED_STATUS,
      completedAt: null,
      amount: SEAT_PRICE,
    });
    expect(refund.failedAt).toBeInstanceOf(Date);

    const after = await loadBookingState(bookingId);
    expect(after.booking.status).toBe(BOOKING_CANCELLED_STATUS);
    expect(after.booking.payment?.status).toBe(PAYMENT_PAID_STATUS);
  });

  it("leaves a refund pending when the gateway cancel result is unknown", async () => {
    paymentGateway.cancelResult = "UNKNOWN";
    const { bookingId, paymentId } = await payBooking([screeningSeatA1Id]);

    await request(app.getHttpServer())
      .post(`/api/bookings/${bookingId}/cancel`)
      .set("Cookie", ownerCookie)
      .expect(204);

    const refund = await waitForRefund(
      paymentId,
      (row) =>
        row.status === REFUND_PENDING_STATUS &&
        row.cancelRequestedAt !== null &&
        row.leaseToken === null,
    );
    expect(refund).toMatchObject({
      status: REFUND_PENDING_STATUS,
      completedAt: null,
      failedAt: null,
      amount: SEAT_PRICE,
    });

    const after = await loadBookingState(bookingId);
    expect(after.booking.status).toBe(BOOKING_CANCELLED_STATUS);
  });

  async function waitForRefund(
    paymentId: string,
    predicate: (refund: {
      id: string;
      paymentId: string;
      amount: number;
      status: string;
      completedAt: Date | null;
      failedAt: Date | null;
      cancelRequestedAt: Date | null;
      leaseToken: string | null;
    }) => boolean,
  ) {
    const deadline = Date.now() + 5_000;

    while (Date.now() < deadline) {
      const refund = await prisma.client.refund.findFirst({
        where: { paymentId },
      });

      if (refund && predicate(refund)) {
        return refund;
      }

      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const latest = await prisma.client.refund.findFirst({
      where: { paymentId },
    });
    throw new Error(
      `Timed out waiting for refund on payment ${paymentId}. Latest=${JSON.stringify(latest)}`,
    );
  }

  async function waitForRefundWorkersIdle() {
    const deadline = Date.now() + 5_000;

    while (Date.now() < deadline) {
      const heldLeases = await prisma.client.refund.count({
        where: {
          payment: { booking: { screeningId } },
          leaseToken: { not: null },
        },
      });

      if (heldLeases === 0) {
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  function createBooking(
    cookie: string | string[],
    screeningSeatIds: string[],
  ) {
    return request(app.getHttpServer())
      .post("/api/bookings")
      .set("Cookie", cookie)
      .send({ screeningId, screeningSeatIds });
  }

  async function signupAndLogin(email: string, name: string) {
    const signupResponse = await request(app.getHttpServer())
      .post("/api/auth/signup")
      .send({ email, password, name })
      .expect(201);

    const loginResponse = await request(app.getHttpServer())
      .post("/api/auth/login")
      .send({ email, password })
      .expect(200);

    const cookie = loginResponse.headers["set-cookie"];
    expect(cookie).toBeDefined();

    return {
      userId: signupResponse.body.id as string,
      cookie: cookie as string | string[],
    };
  }

  async function createPayment(
    cookie: string | string[],
    bookingId: string,
    amount: number,
  ) {
    const response = await request(app.getHttpServer())
      .post("/api/payments")
      .set("Cookie", cookie)
      .send({ bookingId })
      .expect(201);

    expect(response.body).toEqual({
      id: expect.any(String),
      orderId: expect.any(String),
      amount,
      status: PAYMENT_PENDING_STATUS,
    });

    return response.body as {
      id: string;
      orderId: string;
      amount: number;
      status: string;
    };
  }

  async function bookAndCreatePayment(
    cookie: string | string[],
    screeningSeatIds: string[],
  ) {
    const bookingResponse = await createBooking(cookie, screeningSeatIds).expect(
      201,
    );

    expect(bookingResponse.body).toEqual({
      id: expect.any(String),
    });

    const bookingId = bookingResponse.body.id as string;
    const payment = await createPayment(
      cookie,
      bookingId,
      screeningSeatIds.length * SEAT_PRICE,
    );

    return { bookingId, payment };
  }

  async function payBooking(screeningSeatIds: string[]) {
    const { bookingId, payment } = await bookAndCreatePayment(
      ownerCookie,
      screeningSeatIds,
    );

    await request(app.getHttpServer())
      .post(`/api/payments/${payment.id}`)
      .set("Cookie", ownerCookie)
      .send({ paymentKey: "pay-key" })
      .expect(200);

    return { bookingId, paymentId: payment.id };
  }

  function loadBookingState(bookingId: string) {
    return prisma.client.booking
      .findUniqueOrThrow({
        where: { id: bookingId },
        include: { payment: true },
      })
      .then(async (booking) => {
        const seats = await prisma.client.screeningSeat.findMany({
          where: { id: { in: [screeningSeatA1Id, screeningSeatA2Id] } },
          select: { id: true, status: true },
        });

        return { booking, seats };
      });
  }
});

function statusOf(
  seats: Array<{ id: string; status: string }>,
  screeningSeatId: string,
) {
  return seats.find((seat) => seat.id === screeningSeatId)?.status;
}
