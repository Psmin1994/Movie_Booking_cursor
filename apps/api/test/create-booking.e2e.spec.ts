/**
 * Test Intent:
 * 인증된 사용자가 예약 가능한 좌석을 예매하면 PENDING 예매와 좌석 연결이 생기고 그 좌석이 점유됨을 보장한다.
 * 이미 점유된 좌석, 없는 좌석, 다른 상영의 좌석이면 예매와 좌석 연결은 남지 않고 기존 좌석 상태는 유지된다.
 */

import { randomInt, randomUUID } from "node:crypto";
import { INestApplication } from "@nestjs/common";
import { App } from "supertest/types";
import request from "supertest";
import { PrismaService } from "../src/database/prisma.service.js";
import {
  BOOKING_PENDING_STATUS,
  SCREENING_SEAT_AVAILABLE_STATUS,
  SCREENING_SEAT_BOOKED_STATUS,
} from "../src/booking/booking.constants.js";
import { createTestApp } from "./helpers/create-test-app.js";

describe("CreateBooking (e2e)", () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let authCookie: string | string[];
  let userId: string;

  const movieId = randomUUID();
  const screenAId = randomUUID();
  const screenBId = randomUUID();
  const seatA1Id = randomUUID();
  const seatA2Id = randomUUID();
  const seatB1Id = randomUUID();
  const screeningAId = randomUUID();
  const screeningBId = randomUUID();
  const screeningSeatA1Id = randomUUID();
  const screeningSeatA2Id = randomUUID();
  const screeningSeatB1Id = randomUUID();
  const screenNumberA = 700000 + randomInt(10000);
  const screenNumberB = screenNumberA + 1;
  const userEmail = `create-booking-${randomUUID()}@example.com`;
  const startAt = new Date("2099-07-01T10:30:00.000Z");

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  beforeEach(async () => {
    await prisma.client.movie.create({
      data: {
        id: movieId,
        title: "CreateBooking e2e fixture",
        runtime: 120,
        releaseDate: new Date("2020-01-01"),
      },
    });
    await prisma.client.screen.createMany({
      data: [
        {
          id: screenAId,
          number: screenNumberA,
          floor: 1,
          screenType: "2D",
        },
        {
          id: screenBId,
          number: screenNumberB,
          floor: 2,
          screenType: "IMAX",
        },
      ],
    });
    await prisma.client.seat.createMany({
      data: [
        {
          id: seatA1Id,
          screenId: screenAId,
          row: "A",
          number: 1,
          seatType: "STANDARD",
        },
        {
          id: seatA2Id,
          screenId: screenAId,
          row: "A",
          number: 2,
          seatType: "STANDARD",
        },
        {
          id: seatB1Id,
          screenId: screenBId,
          row: "A",
          number: 1,
          seatType: "STANDARD",
        },
      ],
    });
    await prisma.client.screening.createMany({
      data: [
        {
          id: screeningAId,
          movieId,
          screenId: screenAId,
          startAt,
        },
        {
          id: screeningBId,
          movieId,
          screenId: screenBId,
          startAt,
        },
      ],
    });
    await prisma.client.screeningSeat.createMany({
      data: [
        {
          id: screeningSeatA1Id,
          screeningId: screeningAId,
          seatId: seatA1Id,
          status: SCREENING_SEAT_AVAILABLE_STATUS,
        },
        {
          id: screeningSeatA2Id,
          screeningId: screeningAId,
          seatId: seatA2Id,
          status: SCREENING_SEAT_AVAILABLE_STATUS,
        },
        {
          id: screeningSeatB1Id,
          screeningId: screeningBId,
          seatId: seatB1Id,
          status: SCREENING_SEAT_AVAILABLE_STATUS,
        },
      ],
    });

    const signupResponse = await request(app.getHttpServer())
      .post("/api/auth/signup")
      .send({
        email: userEmail,
        password: "password123",
        name: "예매테스터",
      })
      .expect(201);

    userId = signupResponse.body.id;

    const loginResponse = await request(app.getHttpServer())
      .post("/api/auth/login")
      .send({
        email: userEmail,
        password: "password123",
      })
      .expect(200);

    const cookie = loginResponse.headers["set-cookie"];
    expect(cookie).toBeDefined();
    authCookie = cookie as string | string[];
  });

  afterEach(async () => {
    if (!prisma) {
      return;
    }

    await prisma.client.payment.deleteMany({
      where: {
        booking: { screeningId: { in: [screeningAId, screeningBId] } },
      },
    });
    await prisma.client.bookingSeat.deleteMany({
      where: {
        screeningSeatId: {
          in: [screeningSeatA1Id, screeningSeatA2Id, screeningSeatB1Id],
        },
      },
    });
    await prisma.client.booking.deleteMany({
      where: { screeningId: { in: [screeningAId, screeningBId] } },
    });
    await prisma.client.screeningSeat.deleteMany({
      where: { screeningId: { in: [screeningAId, screeningBId] } },
    });
    await prisma.client.screening.deleteMany({
      where: { id: { in: [screeningAId, screeningBId] } },
    });
    await prisma.client.seat.deleteMany({
      where: { screenId: { in: [screenAId, screenBId] } },
    });
    await prisma.client.screen.deleteMany({
      where: { id: { in: [screenAId, screenBId] } },
    });
    await prisma.client.movie.deleteMany({ where: { id: movieId } });
    await prisma.client.user.deleteMany({ where: { email: userEmail } });
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it("creates a booking and occupies available screening seats", async () => {
    const response = await request(app.getHttpServer())
      .post("/api/bookings")
      .set("Cookie", authCookie)
      .send({
        screeningId: screeningAId,
        screeningSeatIds: [screeningSeatA1Id, screeningSeatA2Id],
      })
      .expect(201);

    expect(response.body).toEqual({
      id: expect.any(String),
    });

    const bookings = await prisma.client.booking.findMany({
      where: { userId, screeningId: screeningAId },
    });
    expect(bookings).toHaveLength(1);
    expect(bookings[0]?.id).toBe(response.body.id);
    expect(bookings[0]).toMatchObject({
      userId,
      screeningId: screeningAId,
      status: BOOKING_PENDING_STATUS,
    });

    const bookingSeats = await prisma.client.bookingSeat.findMany({
      where: { bookingId: bookings[0]?.id },
      select: { screeningSeatId: true },
    });
    expect(
      bookingSeats.map((bookingSeat) => bookingSeat.screeningSeatId).sort(),
    ).toEqual([screeningSeatA1Id, screeningSeatA2Id].sort());

    const occupiedSeats = await prisma.client.screeningSeat.findMany({
      where: { id: { in: [screeningSeatA1Id, screeningSeatA2Id] } },
      select: { id: true, status: true },
    });
    expect(occupiedSeats).toEqual(
      expect.arrayContaining([
        { id: screeningSeatA1Id, status: SCREENING_SEAT_BOOKED_STATUS },
        { id: screeningSeatA2Id, status: SCREENING_SEAT_BOOKED_STATUS },
      ]),
    );
    expect(occupiedSeats).toHaveLength(2);
  });

  it("rolls back when a requested seat is already booked", async () => {
    await prisma.client.screeningSeat.update({
      where: { id: screeningSeatA2Id },
      data: { status: SCREENING_SEAT_BOOKED_STATUS },
    });

    const response = await request(app.getHttpServer())
      .post("/api/bookings")
      .set("Cookie", authCookie)
      .send({
        screeningId: screeningAId,
        screeningSeatIds: [screeningSeatA1Id, screeningSeatA2Id],
      })
      .expect(409);

    expect(response.body.message).toBe("이미 예매된 좌석이 포함되어 있습니다.");

    const seatA = await prisma.client.screeningSeat.findUnique({
      where: { id: screeningSeatA1Id },
      select: { status: true },
    });
    const seatB = await prisma.client.screeningSeat.findUnique({
      where: { id: screeningSeatA2Id },
      select: { status: true },
    });
    expect(seatA?.status).toBe(SCREENING_SEAT_AVAILABLE_STATUS);
    expect(seatB?.status).toBe(SCREENING_SEAT_BOOKED_STATUS);

    const bookings = await prisma.client.booking.findMany({
      where: { userId, screeningId: screeningAId },
    });
    const bookingSeats = await prisma.client.bookingSeat.findMany({
      where: {
        screeningSeatId: { in: [screeningSeatA1Id, screeningSeatA2Id] },
      },
    });
    expect(bookings).toEqual([]);
    expect(bookingSeats).toEqual([]);
  });

  it("rejects a request that includes a missing screening seat", async () => {
    const missingScreeningSeatId = randomUUID();

    await request(app.getHttpServer())
      .post("/api/bookings")
      .set("Cookie", authCookie)
      .send({
        screeningId: screeningAId,
        screeningSeatIds: [screeningSeatA1Id, missingScreeningSeatId],
      })
      .expect(404);

    const seatA = await prisma.client.screeningSeat.findUnique({
      where: { id: screeningSeatA1Id },
      select: { status: true },
    });
    expect(seatA?.status).toBe(SCREENING_SEAT_AVAILABLE_STATUS);

    const bookings = await prisma.client.booking.findMany({
      where: { userId, screeningId: screeningAId },
    });
    const bookingSeats = await prisma.client.bookingSeat.findMany({
      where: { screeningSeatId: screeningSeatA1Id },
    });
    expect(bookings).toEqual([]);
    expect(bookingSeats).toEqual([]);
  });

  it("rejects a screening seat that belongs to another screening", async () => {
    await request(app.getHttpServer())
      .post("/api/bookings")
      .set("Cookie", authCookie)
      .send({
        screeningId: screeningAId,
        screeningSeatIds: [screeningSeatB1Id],
      })
      .expect(404);

    const seatA1 = await prisma.client.screeningSeat.findUnique({
      where: { id: screeningSeatA1Id },
      select: { status: true },
    });
    const seatB1 = await prisma.client.screeningSeat.findUnique({
      where: { id: screeningSeatB1Id },
      select: { status: true },
    });
    expect(seatA1?.status).toBe(SCREENING_SEAT_AVAILABLE_STATUS);
    expect(seatB1?.status).toBe(SCREENING_SEAT_AVAILABLE_STATUS);

    const bookings = await prisma.client.booking.findMany({
      where: { screeningId: { in: [screeningAId, screeningBId] } },
    });
    const bookingSeats = await prisma.client.bookingSeat.findMany({
      where: {
        screeningSeatId: {
          in: [screeningSeatA1Id, screeningSeatA2Id, screeningSeatB1Id],
        },
      },
    });
    expect(bookings).toEqual([]);
    expect(bookingSeats).toEqual([]);
  });
});
