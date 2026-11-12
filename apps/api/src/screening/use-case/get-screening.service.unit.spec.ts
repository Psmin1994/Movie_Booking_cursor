/**
 * Test Intent:
 * 존재하는 상영의 영화, 상영관, 좌석 구성을 반환함을 보장한다. 상영이 없으면 찾을 수 없고, 좌석이 없으면 빈 좌석 목록이다.
 */

import { jest } from "@jest/globals";
import { NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { GetScreeningService } from "./get-screening.service.js";
import { ScreeningRepository } from "../repository/screening.repository.js";

const SCREENING_ID = "550e8400-e29b-41d4-a716-446655440002";
const MOVIE_ID = "550e8400-e29b-41d4-a716-446655440000";
const SCREEN_ID = "550e8400-e29b-41d4-a716-446655440001";
const START_AT = "2026-09-20T10:30:00.000Z";
const SCREENING_SEAT_ID = "550e8400-e29b-41d4-a716-446655440010";
const SEAT_ID = "550e8400-e29b-41d4-a716-446655440011";

type FindScreeningDetailById = ScreeningRepository["findScreeningDetailById"];

describe("GetScreeningService", () => {
  let service: GetScreeningService;
  let screeningRepository: {
    findScreeningDetailById: jest.MockedFunction<FindScreeningDetailById>;
  };

  beforeEach(async () => {
    screeningRepository = {
      findScreeningDetailById: jest.fn<FindScreeningDetailById>(),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        GetScreeningService,
        {
          provide: ScreeningRepository,
          useValue: screeningRepository,
        },
      ],
    }).compile();

    service = moduleRef.get(GetScreeningService);
  });

  it("returns screening detail with movie, screen, and mapped seats", async () => {
    screeningRepository.findScreeningDetailById.mockResolvedValue({
      id: SCREENING_ID,
      startAt: new Date(START_AT),
      movie: {
        id: MOVIE_ID,
        title: "Inception",
        posterUrl: "https://example.com/posters/inception.jpg",
        runtime: 148,
      },
      screen: {
        id: SCREEN_ID,
        number: 1,
        floor: 3,
        screenType: "IMAX",
      },
      screeningSeats: [
        {
          id: SCREENING_SEAT_ID,
          status: "AVAILABLE",
          seat: {
            id: SEAT_ID,
            row: "A",
            number: 1,
            seatType: "STANDARD",
          },
        },
      ],
    });

    const result = await service.execute(SCREENING_ID);

    expect(screeningRepository.findScreeningDetailById).toHaveBeenCalledWith(
      SCREENING_ID,
    );
    expect(result).toEqual({
      id: SCREENING_ID,
      startAt: START_AT,
      movie: {
        id: MOVIE_ID,
        title: "Inception",
        posterUrl: "https://example.com/posters/inception.jpg",
        runtime: 148,
      },
      screen: {
        id: SCREEN_ID,
        number: 1,
        floor: 3,
        screenType: "IMAX",
      },
      seats: [
        {
          id: SCREENING_SEAT_ID,
          seatId: SEAT_ID,
          row: "A",
          number: 1,
          seatType: "STANDARD",
          status: "AVAILABLE",
        },
      ],
    });
    expect(result.seats[0]?.id).toBe(SCREENING_SEAT_ID);
    expect(result.seats[0]?.seatId).toBe(SEAT_ID);
  });

  it("throws when the screening does not exist", async () => {
    screeningRepository.findScreeningDetailById.mockResolvedValue(null);

    await expect(service.execute(SCREENING_ID)).rejects.toThrow(
      NotFoundException,
    );
  });

  it("returns an empty seats array when the screening has no seats", async () => {
    screeningRepository.findScreeningDetailById.mockResolvedValue({
      id: SCREENING_ID,
      startAt: new Date(START_AT),
      movie: {
        id: MOVIE_ID,
        title: "Inception",
        posterUrl: null,
        runtime: 148,
      },
      screen: {
        id: SCREEN_ID,
        number: 1,
        floor: 3,
        screenType: "IMAX",
      },
      screeningSeats: [],
    });

    const result = await service.execute(SCREENING_ID);

    expect(result.seats).toEqual([]);
    expect(result.movie.id).toBe(MOVIE_ID);
    expect(result.screen.id).toBe(SCREEN_ID);
  });
});
