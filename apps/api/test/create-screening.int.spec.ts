/**
 * Test Intent:
 * 실제 PostgreSQL에서 상영 좌석 저장이 실패하면 함께 시작한 상영 생성도 남지 않음을 보장한다.
 */

import { randomInt, randomUUID } from "node:crypto";
import { jest } from "@jest/globals";
import { INestApplication } from "@nestjs/common";
import { App } from "supertest/types";
import { PrismaService } from "../src/database/prisma.service.js";
import { CreateScreeningService } from "../src/screening/use-case/create-screening.service.js";
import { ScreeningRepository } from "../src/screening/repository/screening.repository.js";
import { createTestApp } from "./helpers/create-test-app.js";

describe("CreateScreening transaction rollback", () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let createScreeningService: CreateScreeningService;
  let screeningRepository: ScreeningRepository;

  const movieId = randomUUID();
  const screenId = randomUUID();
  const seatId = randomUUID();
  const screenNumber = 800000 + randomInt(100000);
  const startAt = new Date("2099-06-01T10:30:00.000Z");

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    createScreeningService = app.get(CreateScreeningService);
    screeningRepository = app.get(ScreeningRepository);
  });

  beforeEach(async () => {
    await prisma.client.movie.create({
      data: {
        id: movieId,
        title: "CreateScreening rollback fixture",
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
    await prisma.client.seat.create({
      data: {
        id: seatId,
        screenId,
        row: "A",
        number: 1,
        seatType: "STANDARD",
      },
    });
  });

  afterEach(async () => {
    await prisma.client.screeningSeat.deleteMany({
      where: { OR: [{ seatId }, { screening: { screenId } }] },
    });
    await prisma.client.screening.deleteMany({ where: { screenId } });
    await prisma.client.seat.deleteMany({ where: { screenId } });
    await prisma.client.screen.deleteMany({ where: { id: screenId } });
    await prisma.client.movie.deleteMany({ where: { id: movieId } });
  });

  afterAll(async () => {
    await app.close();
  });

  it("rolls back the screening when screening seat creation fails", async () => {
    const createScreening = jest.spyOn(screeningRepository, "createScreening");
    const createScreeningSeats = jest
      .spyOn(screeningRepository, "createScreeningSeats")
      .mockRejectedValue(new Error("seat insert failed"));

    try {
      await expect(
        createScreeningService.execute({
          movieId,
          screenId,
          startAt: startAt.toISOString(),
        }),
      ).rejects.toThrow("seat insert failed");

      expect(createScreening).toHaveBeenCalledTimes(1);
      expect(createScreeningSeats).toHaveBeenCalledTimes(1);
      expect(createScreening.mock.invocationCallOrder[0]).toBeLessThan(
        createScreeningSeats.mock.invocationCallOrder[0],
      );

      const leftoverScreenings = await prisma.client.screening.findMany({
        where: { screenId, startAt },
      });
      const leftoverScreeningSeats = await prisma.client.screeningSeat.findMany({
        where: { seatId },
      });

      expect(leftoverScreenings).toEqual([]);
      expect(leftoverScreeningSeats).toEqual([]);
    } finally {
      createScreening.mockRestore();
      createScreeningSeats.mockRestore();
    }
  });
});
