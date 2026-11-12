/**
 * Test Intent:
 * 인증된 사용자는 자신의 예매만 영화, 상영, 상영관, 좌석과 함께 조회한다.
 * 인증이 없으면 거절되고, 예매가 없으면 빈 목록이다.
 * HTTP로 생성한 예매는 PENDING이며 confirmedAt은 null인 채로 목록에 나타난다.
 * 다른 사용자는 그 예매를 조회할 수 없다.
 */

import { randomInt, randomUUID } from "node:crypto";
import { INestApplication } from "@nestjs/common";
import { App } from "supertest/types";
import request from "supertest";
import { PrismaService } from "../src/database/prisma.service.js";
import {
  BOOKING_CONFIRMED_STATUS,
  BOOKING_PENDING_STATUS,
  SCREENING_SEAT_AVAILABLE_STATUS,
  SCREENING_SEAT_BOOKED_STATUS,
  SEAT_PRICE,
} from "../src/booking/booking.constants.js";
import { createTestApp } from "./helpers/create-test-app.js";

describe("GetMyBookings (e2e)", () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let ownerCookie: string | string[];
  let ownerUserId: string;
  let otherUserId: string;

  const movieId = randomUUID();
  const screenId = randomUUID();
  const seatA1Id = randomUUID();
  const seatA2Id = randomUUID();
  const seatB1Id = randomUUID();
  const screening1Id = randomUUID();
  const screening2Id = randomUUID();
  const screeningSeat1A1Id = randomUUID();
  const screeningSeat1A2Id = randomUUID();
  const screeningSeat1B1Id = randomUUID();
  const screeningSeat2A1Id = randomUUID();
  const screeningSeat2A2Id = randomUUID();
  const olderBookingId = randomUUID();
  const newerBookingId = randomUUID();
  const otherUserBookingId = randomUUID();
  const screenNumber = 800000 + randomInt(10000);
  const ownerEmail = `get-my-bookings-owner-${randomUUID()}@example.com`;
  const otherEmail = `get-my-bookings-other-${randomUUID()}@example.com`;
  const screening1StartAt = new Date("2099-08-01T01:00:00.000Z");
  const screening2StartAt = new Date("2099-08-01T04:30:00.000Z");
  const olderCreatedAt = new Date("2026-09-19T10:00:00.000Z");
  const newerCreatedAt = new Date("2026-09-20T10:30:00.000Z");

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  beforeEach(async () => {
    await prisma.client.movie.create({
      data: {
        id: movieId,
        title: "GetMyBookings e2e fixture",
        runtime: 148,
        releaseDate: new Date("2020-01-01"),
      },
    });
    await prisma.client.screen.create({
      data: {
        id: screenId,
        number: screenNumber,
        floor: 2,
        screenType: "IMAX",
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
        {
          id: seatB1Id,
          screenId,
          row: "B",
          number: 1,
          seatType: "STANDARD",
        },
      ],
    });
    await prisma.client.screening.createMany({
      data: [
        {
          id: screening1Id,
          movieId,
          screenId,
          startAt: screening1StartAt,
        },
        {
          id: screening2Id,
          movieId,
          screenId,
          startAt: screening2StartAt,
        },
      ],
    });
    await prisma.client.screeningSeat.createMany({
      data: [
        {
          id: screeningSeat1A1Id,
          screeningId: screening1Id,
          seatId: seatA1Id,
          status: SCREENING_SEAT_AVAILABLE_STATUS,
        },
        {
          id: screeningSeat1A2Id,
          screeningId: screening1Id,
          seatId: seatA2Id,
          status: SCREENING_SEAT_AVAILABLE_STATUS,
        },
        {
          id: screeningSeat1B1Id,
          screeningId: screening1Id,
          seatId: seatB1Id,
          status: SCREENING_SEAT_AVAILABLE_STATUS,
        },
        {
          id: screeningSeat2A1Id,
          screeningId: screening2Id,
          seatId: seatA1Id,
          status: SCREENING_SEAT_AVAILABLE_STATUS,
        },
        {
          id: screeningSeat2A2Id,
          screeningId: screening2Id,
          seatId: seatA2Id,
          status: SCREENING_SEAT_AVAILABLE_STATUS,
        },
      ],
    });

    const ownerSignup = await request(app.getHttpServer())
      .post("/api/auth/signup")
      .send({
        email: ownerEmail,
        password: "password123",
        name: "예매조회테스터",
      })
      .expect(201);

    ownerUserId = ownerSignup.body.id;

    const otherSignup = await request(app.getHttpServer())
      .post("/api/auth/signup")
      .send({
        email: otherEmail,
        password: "password123",
        name: "다른사용자",
      })
      .expect(201);

    otherUserId = otherSignup.body.id;

    const loginResponse = await request(app.getHttpServer())
      .post("/api/auth/login")
      .send({
        email: ownerEmail,
        password: "password123",
      })
      .expect(200);

    const cookie = loginResponse.headers["set-cookie"];
    expect(cookie).toBeDefined();
    ownerCookie = cookie as string | string[];
  });

  afterEach(async () => {
    if (!prisma) {
      return;
    }

    await prisma.client.bookingSeat.deleteMany({
      where: {
        screeningSeatId: {
          in: [
            screeningSeat1A1Id,
            screeningSeat1A2Id,
            screeningSeat1B1Id,
            screeningSeat2A1Id,
            screeningSeat2A2Id,
          ],
        },
      },
    });
    await prisma.client.booking.deleteMany({
      where: { screeningId: { in: [screening1Id, screening2Id] } },
    });
    await prisma.client.screeningSeat.deleteMany({
      where: { screeningId: { in: [screening1Id, screening2Id] } },
    });
    await prisma.client.screening.deleteMany({
      where: { id: { in: [screening1Id, screening2Id] } },
    });
    await prisma.client.seat.deleteMany({
      where: { screenId },
    });
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

  async function createOwnerAndOtherBookings() {
    await prisma.client.booking.create({
      data: {
        id: olderBookingId,
        userId: ownerUserId,
        screeningId: screening1Id,
        status: BOOKING_CONFIRMED_STATUS,
        totalAmount: 3 * SEAT_PRICE,
        createdAt: olderCreatedAt,
        expiresAt: olderCreatedAt,
        confirmedAt: olderCreatedAt,
      },
    });
    await prisma.client.bookingSeat.createMany({
      data: [
        {
          bookingId: olderBookingId,
          screeningSeatId: screeningSeat1B1Id,
        },
        {
          bookingId: olderBookingId,
          screeningSeatId: screeningSeat1A2Id,
        },
        {
          bookingId: olderBookingId,
          screeningSeatId: screeningSeat1A1Id,
        },
      ],
    });
    await prisma.client.screeningSeat.updateMany({
      where: {
        id: {
          in: [screeningSeat1A1Id, screeningSeat1A2Id, screeningSeat1B1Id],
        },
      },
      data: { status: SCREENING_SEAT_BOOKED_STATUS },
    });

    await prisma.client.booking.create({
      data: {
        id: newerBookingId,
        userId: ownerUserId,
        screeningId: screening2Id,
        status: BOOKING_CONFIRMED_STATUS,
        totalAmount: SEAT_PRICE,
        createdAt: newerCreatedAt,
        expiresAt: newerCreatedAt,
        confirmedAt: newerCreatedAt,
      },
    });
    await prisma.client.bookingSeat.create({
      data: {
        bookingId: newerBookingId,
        screeningSeatId: screeningSeat2A1Id,
      },
    });
    await prisma.client.screeningSeat.update({
      where: { id: screeningSeat2A1Id },
      data: { status: SCREENING_SEAT_BOOKED_STATUS },
    });

    await prisma.client.booking.create({
      data: {
        id: otherUserBookingId,
        userId: otherUserId,
        screeningId: screening2Id,
        status: BOOKING_CONFIRMED_STATUS,
        totalAmount: SEAT_PRICE,
        createdAt: newerCreatedAt,
        expiresAt: newerCreatedAt,
        confirmedAt: newerCreatedAt,
      },
    });
    await prisma.client.bookingSeat.create({
      data: {
        bookingId: otherUserBookingId,
        screeningSeatId: screeningSeat2A2Id,
      },
    });
    await prisma.client.screeningSeat.update({
      where: { id: screeningSeat2A2Id },
      data: { status: SCREENING_SEAT_BOOKED_STATUS },
    });
  }

  it("returns 401 when the request has no auth cookie", async () => {
    await request(app.getHttpServer()).get("/api/bookings").expect(401);
  });

  it("returns an empty array when the user has no bookings", async () => {
    const response = await request(app.getHttpServer())
      .get("/api/bookings")
      .set("Cookie", ownerCookie)
      .expect(200);

    expect(response.body).toEqual([]);
  });

  it("returns only the authenticated user's bookings with nested movie, screening, screen, and seats", async () => {
    await createOwnerAndOtherBookings();

    const response = await request(app.getHttpServer())
      .get("/api/bookings")
      .set("Cookie", ownerCookie)
      .expect(200);

    expect(response.body).toHaveLength(2);
    expect(response.body.map((booking: { id: string }) => booking.id)).toEqual([
      newerBookingId,
      olderBookingId,
    ]);
    expect(
      response.body.map((booking: { id: string }) => booking.id),
    ).not.toContain(otherUserBookingId);

    expect(response.body[0]).toEqual({
      id: newerBookingId,
      status: BOOKING_CONFIRMED_STATUS,
      confirmedAt: newerCreatedAt.toISOString(),
      movie: {
        id: movieId,
        title: "GetMyBookings e2e fixture",
      },
      screening: {
        id: screening2Id,
        startAt: screening2StartAt.toISOString(),
      },
      screen: {
        id: screenId,
        number: screenNumber,
        floor: 2,
        screenType: "IMAX",
      },
      seats: [
        {
          id: screeningSeat2A1Id,
          row: "A",
          number: 1,
        },
      ],
    });

    expect(response.body[1]).toMatchObject({
      id: olderBookingId,
      status: BOOKING_CONFIRMED_STATUS,
      confirmedAt: olderCreatedAt.toISOString(),
      movie: {
        id: movieId,
        title: "GetMyBookings e2e fixture",
      },
      screening: {
        id: screening1Id,
        startAt: screening1StartAt.toISOString(),
      },
      screen: {
        id: screenId,
        number: screenNumber,
        floor: 2,
        screenType: "IMAX",
      },
    });
    expect(response.body[1].seats).toEqual([
      { id: screeningSeat1A1Id, row: "A", number: 1 },
      { id: screeningSeat1A2Id, row: "A", number: 2 },
      { id: screeningSeat1B1Id, row: "B", number: 1 },
    ]);
  });

  it("still creates a booking through POST /api/bookings and includes it in the list", async () => {
    const createResponse = await request(app.getHttpServer())
      .post("/api/bookings")
      .set("Cookie", ownerCookie)
      .send({
        screeningId: screening1Id,
        screeningSeatIds: [screeningSeat1A1Id, screeningSeat1A2Id],
      })
      .expect(201);

    expect(createResponse.body).toEqual({
      id: expect.any(String),
    });

    const listResponse = await request(app.getHttpServer())
      .get("/api/bookings")
      .set("Cookie", ownerCookie)
      .expect(200);

    expect(listResponse.body).toHaveLength(1);
    expect(listResponse.body[0]).toEqual({
      id: createResponse.body.id,
      status: BOOKING_PENDING_STATUS,
      confirmedAt: null,
      movie: {
        id: movieId,
        title: "GetMyBookings e2e fixture",
      },
      screening: {
        id: screening1Id,
        startAt: screening1StartAt.toISOString(),
      },
      screen: {
        id: screenId,
        number: screenNumber,
        floor: 2,
        screenType: "IMAX",
      },
      seats: [
        { id: screeningSeat1A1Id, row: "A", number: 1 },
        { id: screeningSeat1A2Id, row: "A", number: 2 },
      ],
    });

    const otherLogin = await request(app.getHttpServer())
      .post("/api/auth/login")
      .send({
        email: otherEmail,
        password: "password123",
      })
      .expect(200);

    const otherCookie = otherLogin.headers["set-cookie"];
    expect(otherCookie).toBeDefined();

    const otherList = await request(app.getHttpServer())
      .get("/api/bookings")
      .set("Cookie", otherCookie)
      .expect(200);

    expect(
      otherList.body.map((booking: { id: string }) => booking.id),
    ).not.toContain(createResponse.body.id);
  });
});
