/**
 * Test Intent:
 * 존재하는 영화와 상영관의 좌석으로 상영과 상영 좌석이 함께 생성됨을 보장한다. 영화나 상영관이 없거나 같은 일정이 이미 있으면 상영은 남지 않는다. 좌석 생성이 실패하면 그 예외가 전파된다.
 */

import { jest } from "@jest/globals";
import { Prisma } from "@movie-booking/database-prisma";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PrismaService } from "../../database/prisma.service.js";
import { MovieRepository } from "../../movie/repository/movie.repository.js";
import { CreateScreeningService } from "./create-screening.service.js";
import { SCREENING_SEAT_INITIAL_STATUS } from "../screening.constants.js";
import { ScreeningRepository } from "../repository/screening.repository.js";

const MOVIE_ID = "550e8400-e29b-41d4-a716-446655440000";
const SCREEN_ID = "550e8400-e29b-41d4-a716-446655440001";
const START_AT = "2026-09-20T10:30:00.000Z";
const TX = { name: "transaction-client" } as unknown as Prisma.TransactionClient;

type ScreeningRepositoryMocks = {
  [K in
    | "findScreenById"
    | "findSeatsByScreenId"
    | "createScreening"
    | "createScreeningSeats"]: jest.MockedFunction<ScreeningRepository[K]>;
};

type MovieRepositoryMocks = {
  existsById: jest.MockedFunction<MovieRepository["existsById"]>;
};

type RunTransaction = (
  callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
) => Promise<unknown>;

describe("CreateScreeningService", () => {
  let service: CreateScreeningService;
  let movieRepository: MovieRepositoryMocks;
  let screeningRepository: ScreeningRepositoryMocks;
  let transaction: jest.MockedFunction<RunTransaction>;

  beforeEach(async () => {
    movieRepository = {
      existsById: jest.fn<MovieRepository["existsById"]>(),
    };
    screeningRepository = {
      findScreenById: jest.fn<ScreeningRepository["findScreenById"]>(),
      findSeatsByScreenId: jest.fn<ScreeningRepository["findSeatsByScreenId"]>(),
      createScreening: jest.fn<ScreeningRepository["createScreening"]>(),
      createScreeningSeats: jest.fn<ScreeningRepository["createScreeningSeats"]>(),
    };
    transaction = jest.fn<RunTransaction>(async (callback) => callback(TX));

    const moduleRef = await Test.createTestingModule({
      providers: [
        CreateScreeningService,
        {
          provide: PrismaService,
          useValue: {
            client: {
              $transaction: transaction,
            },
          },
        },
        {
          provide: MovieRepository,
          useValue: movieRepository,
        },
        {
          provide: ScreeningRepository,
          useValue: screeningRepository,
        },
      ],
    }).compile();

    service = moduleRef.get(CreateScreeningService);
  });

  it("creates a screening and all screening seats when the screen has seats", async () => {
    movieRepository.existsById.mockResolvedValue(true);
    screeningRepository.findScreenById.mockResolvedValue({ id: SCREEN_ID });
    screeningRepository.findSeatsByScreenId.mockResolvedValue([
      { id: "seat-1" },
      { id: "seat-2" },
    ]);
    screeningRepository.createScreening.mockResolvedValue({
      id: "screening-1",
      movieId: MOVIE_ID,
      screenId: SCREEN_ID,
      startAt: new Date(START_AT),
    });
    screeningRepository.createScreeningSeats.mockResolvedValue({ count: 2 });

    const result = await service.execute({
      movieId: MOVIE_ID,
      screenId: SCREEN_ID,
      startAt: START_AT,
    });

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(movieRepository.existsById).toHaveBeenCalledWith(MOVIE_ID, TX);
    expect(screeningRepository.findScreenById).toHaveBeenCalledWith(
      TX,
      SCREEN_ID,
    );
    expect(screeningRepository.findSeatsByScreenId).toHaveBeenCalledWith(
      TX,
      SCREEN_ID,
    );
    expect(screeningRepository.createScreening).toHaveBeenCalledWith(TX, {
      movieId: MOVIE_ID,
      screenId: SCREEN_ID,
      startAt: new Date(START_AT),
    });
    expect(SCREENING_SEAT_INITIAL_STATUS).toBe("AVAILABLE");
    expect(screeningRepository.createScreeningSeats).toHaveBeenCalledWith(TX, {
      screeningId: "screening-1",
      seatIds: ["seat-1", "seat-2"],
      status: SCREENING_SEAT_INITIAL_STATUS,
    });
    expect(result).toEqual({
      id: "screening-1",
      movieId: MOVIE_ID,
      screenId: SCREEN_ID,
      startAt: START_AT,
    });
  });

  it("throws when the movie does not exist", async () => {
    movieRepository.existsById.mockResolvedValue(false);

    await expect(
      service.execute({
        movieId: MOVIE_ID,
        screenId: SCREEN_ID,
        startAt: START_AT,
      }),
    ).rejects.toThrow(NotFoundException);

    expect(screeningRepository.createScreening).not.toHaveBeenCalled();
    expect(screeningRepository.createScreeningSeats).not.toHaveBeenCalled();
  });

  it("throws when the screen does not exist", async () => {
    movieRepository.existsById.mockResolvedValue(true);
    screeningRepository.findScreenById.mockResolvedValue(null);

    await expect(
      service.execute({
        movieId: MOVIE_ID,
        screenId: SCREEN_ID,
        startAt: START_AT,
      }),
    ).rejects.toThrow(NotFoundException);

    expect(screeningRepository.createScreening).not.toHaveBeenCalled();
    expect(screeningRepository.createScreeningSeats).not.toHaveBeenCalled();
  });

  it("creates a screening with no screening seats when the screen has no seats", async () => {
    movieRepository.existsById.mockResolvedValue(true);
    screeningRepository.findScreenById.mockResolvedValue({ id: SCREEN_ID });
    screeningRepository.findSeatsByScreenId.mockResolvedValue([]);
    screeningRepository.createScreening.mockResolvedValue({
      id: "screening-1",
      movieId: MOVIE_ID,
      screenId: SCREEN_ID,
      startAt: new Date(START_AT),
    });
    screeningRepository.createScreeningSeats.mockResolvedValue({ count: 0 });

    const result = await service.execute({
      movieId: MOVIE_ID,
      screenId: SCREEN_ID,
      startAt: START_AT,
    });

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(screeningRepository.createScreening).toHaveBeenCalledWith(TX, {
      movieId: MOVIE_ID,
      screenId: SCREEN_ID,
      startAt: new Date(START_AT),
    });
    expect(screeningRepository.createScreeningSeats).toHaveBeenCalledWith(TX, {
      screeningId: "screening-1",
      seatIds: [],
      status: SCREENING_SEAT_INITIAL_STATUS,
    });
    expect(result).toEqual({
      id: "screening-1",
      movieId: MOVIE_ID,
      screenId: SCREEN_ID,
      startAt: START_AT,
    });
  });

  it("propagates the error when screening seat creation fails", async () => {
    movieRepository.existsById.mockResolvedValue(true);
    screeningRepository.findScreenById.mockResolvedValue({ id: SCREEN_ID });
    screeningRepository.findSeatsByScreenId.mockResolvedValue([{ id: "seat-1" }]);
    screeningRepository.createScreening.mockResolvedValue({
      id: "screening-1",
      movieId: MOVIE_ID,
      screenId: SCREEN_ID,
      startAt: new Date(START_AT),
    });
    screeningRepository.createScreeningSeats.mockRejectedValue(
      new Error("seat insert failed"),
    );

    await expect(
      service.execute({
        movieId: MOVIE_ID,
        screenId: SCREEN_ID,
        startAt: START_AT,
      }),
    ).rejects.toThrow("seat insert failed");

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(screeningRepository.createScreening).toHaveBeenCalledWith(TX, {
      movieId: MOVIE_ID,
      screenId: SCREEN_ID,
      startAt: new Date(START_AT),
    });
    expect(screeningRepository.createScreeningSeats).toHaveBeenCalledWith(TX, {
      screeningId: "screening-1",
      seatIds: ["seat-1"],
      status: SCREENING_SEAT_INITIAL_STATUS,
    });
  });

  it("throws when the screening schedule already exists", async () => {
    movieRepository.existsById.mockResolvedValue(true);
    screeningRepository.findScreenById.mockResolvedValue({ id: SCREEN_ID });
    screeningRepository.findSeatsByScreenId.mockResolvedValue([{ id: "seat-1" }]);
    screeningRepository.createScreening.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "7.10.0",
        meta: { target: ["screenId", "startAt"] },
      }),
    );

    await expect(
      service.execute({
        movieId: MOVIE_ID,
        screenId: SCREEN_ID,
        startAt: START_AT,
      }),
    ).rejects.toThrow(ConflictException);
  });
});
