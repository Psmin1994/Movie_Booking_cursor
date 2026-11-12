/**
 * Test Intent:
 * 영화와 서울 날짜로 조회하면 그날 시작하는 상영만 상영관별로 반환함을 보장한다. 상영이 없는 날은 빈 목록이고, 없는 날짜와 잘못된 형식은 거절된다.
 */

import { randomInt, randomUUID } from "node:crypto";
import { INestApplication } from "@nestjs/common";
import { App } from "supertest/types";
import request from "supertest";
import { PrismaService } from "../src/database/prisma.service.js";
import { createTestApp } from "./helpers/create-test-app.js";

describe("ListScreeningsByMovieAndDate (e2e)", () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  const movieId = randomUUID();
  const otherMovieId = randomUUID();
  const screen1Id = randomUUID();
  const screen2Id = randomUUID();
  const screenNumber1 = 900000 + randomInt(10000);
  const screenNumber2 = screenNumber1 + 1;
  const date = "2026-09-20";

  const includedLateBoundary = new Date("2026-09-20T14:59:59.999Z");
  const excludedNextDay = new Date("2026-09-20T15:00:00.000Z");
  const excludedPreviousDay = new Date("2026-09-19T14:59:59.999Z");

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  beforeEach(async () => {
    await prisma.client.movie.createMany({
      data: [
        {
          id: movieId,
          title: "List screenings fixture",
          runtime: 120,
          releaseDate: new Date("2020-01-01"),
        },
        {
          id: otherMovieId,
          title: "Other movie fixture",
          runtime: 90,
          releaseDate: new Date("2020-01-01"),
        },
      ],
    });
    await prisma.client.screen.createMany({
      data: [
        {
          id: screen1Id,
          number: screenNumber1,
          floor: 2,
          screenType: "IMAX",
        },
        {
          id: screen2Id,
          number: screenNumber2,
          floor: 3,
          screenType: "2D",
        },
      ],
    });
    await prisma.client.screening.createMany({
      data: [
        {
          id: randomUUID(),
          movieId,
          screenId: screen1Id,
          startAt: new Date("2026-09-20T01:00:00.000Z"),
        },
        {
          id: randomUUID(),
          movieId,
          screenId: screen1Id,
          startAt: new Date("2026-09-20T04:30:00.000Z"),
        },
        {
          id: randomUUID(),
          movieId,
          screenId: screen1Id,
          startAt: includedLateBoundary,
        },
        {
          id: randomUUID(),
          movieId,
          screenId: screen2Id,
          startAt: new Date("2026-09-20T01:00:00.000Z"),
        },
        {
          id: randomUUID(),
          movieId,
          screenId: screen1Id,
          startAt: excludedNextDay,
        },
        {
          id: randomUUID(),
          movieId,
          screenId: screen1Id,
          startAt: excludedPreviousDay,
        },
        {
          id: randomUUID(),
          movieId: otherMovieId,
          screenId: screen1Id,
          startAt: new Date("2026-09-20T02:00:00.000Z"),
        },
      ],
    });
  });

  afterEach(async () => {
    await prisma.client.screening.deleteMany({
      where: { movieId: { in: [movieId, otherMovieId] } },
    });
    await prisma.client.screen.deleteMany({
      where: { id: { in: [screen1Id, screen2Id] } },
    });
    await prisma.client.movie.deleteMany({
      where: { id: { in: [movieId, otherMovieId] } },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it("returns screenings grouped by screen.id in repository sort order", async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/movies/${movieId}/screenings`)
      .query({ date })
      .expect(200);

    expect(response.body.date).toBe(date);
    expect(response.body.screens).toHaveLength(2);
    expect(response.body.screens[0].screen).toEqual({
      id: screen1Id,
      number: screenNumber1,
      floor: 2,
      screenType: "IMAX",
    });
    expect(response.body.screens[1].screen).toEqual({
      id: screen2Id,
      number: screenNumber2,
      floor: 3,
      screenType: "2D",
    });
    expect(
      response.body.screens[0].screenings.map(
        (screening: { startTime: string }) => screening.startTime,
      ),
    ).toEqual(["10:00", "13:30", "23:59"]);
    expect(response.body.screens[1].screenings).toEqual([
      expect.objectContaining({ startTime: "10:00" }),
    ]);
    expect(response.body.screens[0].screenings[0].id).toEqual(
      expect.any(String),
    );
    expect(response.body.screens[0].screenings[0]).not.toHaveProperty(
      "startAt",
    );
  });

  it("includes 23:59:59.999 KST and excludes 00:00:00.000 KST of the next day", async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/movies/${movieId}/screenings`)
      .query({ date })
      .expect(200);

    const startTimes = response.body.screens.flatMap(
      (group: { screenings: { startTime: string }[] }) =>
        group.screenings.map((screening) => screening.startTime),
    );

    expect(startTimes).toContain("23:59");
    expect(startTimes).not.toContain("00:00");
  });

  it("returns an empty screens array when the date has no screenings", async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/movies/${movieId}/screenings`)
      .query({ date: "2026-09-22" })
      .expect(200);

    expect(response.body).toEqual({
      date: "2026-09-22",
      screens: [],
    });
  });

  it("rejects nonexistent calendar dates and invalid formats", async () => {
    await request(app.getHttpServer())
      .get(`/api/movies/${movieId}/screenings`)
      .query({ date: "2026-02-31" })
      .expect(400);

    await request(app.getHttpServer())
      .get(`/api/movies/${movieId}/screenings`)
      .query({ date: "2026/09/20" })
      .expect(400);

    await request(app.getHttpServer())
      .get(`/api/movies/${movieId}/screenings`)
      .query({ date: "2026-09-20T10:00:00.000Z" })
      .expect(400);

    await request(app.getHttpServer())
      .get(`/api/movies/${movieId}/screenings`)
      .expect(400);
  });
});
