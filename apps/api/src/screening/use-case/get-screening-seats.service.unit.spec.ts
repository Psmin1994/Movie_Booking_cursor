/**
 * Test Intent:
 * 아직 시작하지 않은 상영의 좌석만 조회됨을 보장한다. 상영이 없거나 시작 시각이 현재보다 이전이거나 같으면 좌석을 반환하지 않는다.
 */

import { jest } from "@jest/globals";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { GetScreeningSeatsService } from "./get-screening-seats.service.js";
import { ScreeningRepository } from "../repository/screening.repository.js";

const SCREENING_ID = "550e8400-e29b-41d4-a716-446655440002";
const NOW = Date.parse("2026-09-24T09:00:00.000Z");
const FUTURE_START_AT = new Date("2026-09-24T10:30:00.000Z");

type FindScreeningById = ScreeningRepository["findScreeningById"];
type FindScreeningSeatsByScreeningId =
  ScreeningRepository["findScreeningSeatsByScreeningId"];

describe("GetScreeningSeatsService", () => {
  let service: GetScreeningSeatsService;
  let screeningRepository: {
    findScreeningById: jest.MockedFunction<FindScreeningById>;
    findScreeningSeatsByScreeningId: jest.MockedFunction<FindScreeningSeatsByScreeningId>;
  };

  beforeEach(async () => {
    jest.spyOn(Date, "now").mockReturnValue(NOW);

    screeningRepository = {
      findScreeningById: jest.fn<FindScreeningById>(),
      findScreeningSeatsByScreeningId:
        jest.fn<FindScreeningSeatsByScreeningId>(),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        GetScreeningSeatsService,
        {
          provide: ScreeningRepository,
          useValue: screeningRepository,
        },
      ],
    }).compile();

    service = moduleRef.get(GetScreeningSeatsService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("returns repository seats as DTOs in repository order", async () => {
    screeningRepository.findScreeningById.mockResolvedValue({
      id: SCREENING_ID,
      startAt: FUTURE_START_AT,
    });
    screeningRepository.findScreeningSeatsByScreeningId.mockResolvedValue([
      {
        id: "550e8400-e29b-41d4-a716-446655440012",
        status: "AVAILABLE",
        seat: { row: "B", number: 1 },
      },
      {
        id: "550e8400-e29b-41d4-a716-446655440011",
        status: "BOOKED",
        seat: { row: "A", number: 2 },
      },
      {
        id: "550e8400-e29b-41d4-a716-446655440010",
        status: "AVAILABLE",
        seat: { row: "A", number: 1 },
      },
    ]);

    const result = await service.execute(SCREENING_ID);

    expect(screeningRepository.findScreeningById).toHaveBeenCalledWith(
      SCREENING_ID,
    );
    expect(
      screeningRepository.findScreeningSeatsByScreeningId,
    ).toHaveBeenCalledWith(SCREENING_ID);
    expect(result).toEqual({
      seats: [
        {
          id: "550e8400-e29b-41d4-a716-446655440012",
          row: "B",
          number: 1,
          status: "AVAILABLE",
        },
        {
          id: "550e8400-e29b-41d4-a716-446655440011",
          row: "A",
          number: 2,
          status: "BOOKED",
        },
        {
          id: "550e8400-e29b-41d4-a716-446655440010",
          row: "A",
          number: 1,
          status: "AVAILABLE",
        },
      ],
    });
  });

  it("throws when the screening does not exist", async () => {
    screeningRepository.findScreeningById.mockResolvedValue(null);

    await expect(service.execute(SCREENING_ID)).rejects.toThrow(
      NotFoundException,
    );

    expect(screeningRepository.findScreeningById).toHaveBeenCalledWith(
      SCREENING_ID,
    );
    expect(
      screeningRepository.findScreeningSeatsByScreeningId,
    ).not.toHaveBeenCalled();
  });

  it("rejects a screening whose startAt is before now", async () => {
    screeningRepository.findScreeningById.mockResolvedValue({
      id: SCREENING_ID,
      startAt: new Date(NOW - 1),
    });

    await expect(service.execute(SCREENING_ID)).rejects.toThrow(
      ConflictException,
    );

    expect(
      screeningRepository.findScreeningSeatsByScreeningId,
    ).not.toHaveBeenCalled();
  });

  it("rejects a screening whose startAt is equal to now", async () => {
    screeningRepository.findScreeningById.mockResolvedValue({
      id: SCREENING_ID,
      startAt: new Date(NOW),
    });

    await expect(service.execute(SCREENING_ID)).rejects.toThrow(
      ConflictException,
    );

    expect(
      screeningRepository.findScreeningSeatsByScreeningId,
    ).not.toHaveBeenCalled();
  });
});
