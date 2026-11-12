/**
 * Test Intent:
 * 사용자가 결제 전 예매를 취소하면 예매는 CANCELLED가 되고 좌석은 풀리며 환불은 생기지 않음을 보장한다. 결제가 있던 취소는 그 결제를 CANCELED로 남긴다. 인증이 없거나 타인 소유이거나 보유 시간이 지난 예매는 거절되고 기존 상태를 바꾸지 않는다.
 */

import { randomInt, randomUUID } from "node:crypto";
import { INestApplication } from "@nestjs/common";
import { App } from "supertest/types";
import request from "supertest";
import { PrismaService } from "../src/database/prisma.service.js";
import {
  BOOKING_CANCELLED_STATUS,
  BOOKING_PENDING_STATUS,
  SCREENING_SEAT_AVAILABLE_STATUS,
  SCREENING_SEAT_BOOKED_STATUS,
} from "../src/booking/booking.constants.js";
import { PAYMENT_CANCELED_STATUS } from "../src/payment/payment.constants.js";
import { createTestApp } from "./helpers/create-test-app.js";

describe("Cancel pending booking (e2e)", () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let ownerCookie: string | string[];
  let otherCookie: string | string[];

  const movieId = randomUUID();
  const screenId = randomUUID();
  const seatId = randomUUID();
  const screeningId = randomUUID();
  const screeningSeatId = randomUUID();
  const screenNumber = 920000 + randomInt(10000);
  const ownerEmail = `cancel-pending-owner-${randomUUID()}@example.com`;
  const otherEmail = `cancel-pending-other-${randomUUID()}@example.com`;
  const password = "password123";

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  beforeEach(async () => {
    await prisma.client.movie.create({
      data: {
        id: movieId,
        title: "Cancel pending e2e fixture",
        runtime: 100,
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
    await prisma.client.seat.create({
      data: {
        id: seatId,
        screenId,
        row: "A",
        number: 1,
        seatType: "STANDARD",
      },
    });
    await prisma.client.screening.create({
      data: {
        id: screeningId,
        movieId,
        screenId,
        startAt: new Date("2099-09-01T10:30:00.000Z"),
      },
    });
    await prisma.client.screeningSeat.create({
      data: {
        id: screeningSeatId,
        screeningId,
        seatId,
        status: SCREENING_SEAT_AVAILABLE_STATUS,
      },
    });

    ownerCookie = (await signupAndLogin(ownerEmail, "예매테스터")).cookie;
    otherCookie = (await signupAndLogin(otherEmail, "다른사용자")).cookie;
  });

  afterEach(async () => {
    if (!prisma) {
      return;
    }

    await prisma.client.refund.deleteMany({
      where: { payment: { booking: { screeningId } } },
    });
    await prisma.client.payment.deleteMany({
      where: { booking: { screeningId } },
    });
    await prisma.client.bookingSeat.deleteMany({
      where: { screeningSeatId },
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

  it("cancels a pending booking before a payment exists and releases the seat", async () => {
    const bookingId = await createBooking(ownerCookie);

    await request(app.getHttpServer())
      .post(`/api/bookings/${bookingId}/cancel-pending`)
      .set("Cookie", ownerCookie)
      .expect(204);

    const booking = await prisma.client.booking.findUniqueOrThrow({
      where: { id: bookingId },
      include: { payment: true },
    });
    const seat = await prisma.client.screeningSeat.findUniqueOrThrow({
      where: { id: screeningSeatId },
    });

    expect(booking.status).toBe(BOOKING_CANCELLED_STATUS);
    expect(booking.cancelledAt).toEqual(expect.any(Date));
    expect(booking.payment).toBeNull();
    expect(seat.status).toBe(SCREENING_SEAT_AVAILABLE_STATUS);
    expect(await prisma.client.refund.count({ where: { payment: { bookingId } } })).toBe(0);
  });

  it("cancels the pending payment when the user cancels after payment creation", async () => {
    const bookingId = await createBooking(ownerCookie);
    const paymentResponse = await request(app.getHttpServer())
      .post("/api/payments")
      .set("Cookie", ownerCookie)
      .send({ bookingId })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/api/bookings/${bookingId}/cancel-pending`)
      .set("Cookie", ownerCookie)
      .expect(204);

    const booking = await prisma.client.booking.findUniqueOrThrow({
      where: { id: bookingId },
      include: { payment: true },
    });
    const seat = await prisma.client.screeningSeat.findUniqueOrThrow({
      where: { id: screeningSeatId },
    });

    expect(booking.status).toBe(BOOKING_CANCELLED_STATUS);
    expect(booking.payment).toMatchObject({
      id: paymentResponse.body.id,
      status: PAYMENT_CANCELED_STATUS,
    });
    expect(seat.status).toBe(SCREENING_SEAT_AVAILABLE_STATUS);
    expect(await prisma.client.refund.count({ where: { paymentId: paymentResponse.body.id } })).toBe(0);
  });

  it("rejects cancel without authentication", async () => {
    const bookingId = await createBooking(ownerCookie);

    await request(app.getHttpServer()).post(`/api/bookings/${bookingId}/cancel-pending`).expect(401);

    const booking = await prisma.client.booking.findUniqueOrThrow({ where: { id: bookingId } });
    expect(booking.status).toBe(BOOKING_PENDING_STATUS);
  });

  it("rejects cancel by another user", async () => {
    const bookingId = await createBooking(ownerCookie);

    await request(app.getHttpServer())
      .post(`/api/bookings/${bookingId}/cancel-pending`)
      .set("Cookie", otherCookie)
      .expect(404);

    const booking = await prisma.client.booking.findUniqueOrThrow({ where: { id: bookingId } });
    const seat = await prisma.client.screeningSeat.findUniqueOrThrow({ where: { id: screeningSeatId } });
    expect(booking.status).toBe(BOOKING_PENDING_STATUS);
    expect(seat.status).toBe(SCREENING_SEAT_BOOKED_STATUS);
  });

  it("rejects cancel after the hold has expired and leaves the booking pending", async () => {
    const bookingId = await createBooking(ownerCookie);
    await prisma.client.booking.update({
      where: { id: bookingId },
      data: { expiresAt: new Date("2000-01-01T00:00:00.000Z") },
    });

    await request(app.getHttpServer())
      .post(`/api/bookings/${bookingId}/cancel-pending`)
      .set("Cookie", ownerCookie)
      .expect(409);

    const booking = await prisma.client.booking.findUniqueOrThrow({ where: { id: bookingId } });
    const seat = await prisma.client.screeningSeat.findUniqueOrThrow({ where: { id: screeningSeatId } });
    expect(booking.status).toBe(BOOKING_PENDING_STATUS);
    expect(booking.cancelledAt).toBeNull();
    expect(seat.status).toBe(SCREENING_SEAT_BOOKED_STATUS);
  });

  async function createBooking(cookie: string | string[]) {
    const response = await request(app.getHttpServer())
      .post("/api/bookings")
      .set("Cookie", cookie)
      .send({ screeningId, screeningSeatIds: [screeningSeatId] })
      .expect(201);

    expect(response.body).toEqual({
      id: expect.any(String),
    });

    return response.body.id as string;
  }

  async function signupAndLogin(email: string, name: string) {
    await request(app.getHttpServer()).post("/api/auth/signup").send({ email, password, name }).expect(201);

    const loginResponse = await request(app.getHttpServer())
      .post("/api/auth/login")
      .send({ email, password })
      .expect(200);

    const cookie = loginResponse.headers["set-cookie"];
    expect(cookie).toBeDefined();

    return { cookie: cookie as string | string[] };
  }
});
