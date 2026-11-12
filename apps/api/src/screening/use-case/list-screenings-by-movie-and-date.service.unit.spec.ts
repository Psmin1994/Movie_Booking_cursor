/**
 * Test Intent:
 * 서울 달력의 하루 안에 시작하는 상영만 상영관별로 묶어 반환함을 보장한다. 그 날짜에 상영이 없으면 빈 목록이다.
 */

import { jest } from "@jest/globals";
import { Test } from "@nestjs/testing";
import { ListScreeningsByMovieAndDateService } from "./list-screenings-by-movie-and-date.service.js";
import { ScreeningRepository } from "../repository/screening.repository.js";

const MOVIE_ID = "550e8400-e29b-41d4-a716-446655440000";
const DATE = "2026-09-20";
const RANGE_FROM = new Date("2026-09-19T15:00:00.000Z");
const RANGE_TO = new Date("2026-09-20T15:00:00.000Z");
const SCREEN_1_ID = "screen-1";
const SCREEN_2_ID = "screen-2";

type FindScreeningsByMovieIdAndDateRange =
  ScreeningRepository["findScreeningsByMovieIdAndDateRange"];

describe("ListScreeningsByMovieAndDateService", () => {
  let service: ListScreeningsByMovieAndDateService;
  let screeningRepository: {
    findScreeningsByMovieIdAndDateRange: jest.MockedFunction<FindScreeningsByMovieIdAndDateRange>;
  };

  beforeEach(async () => {
    screeningRepository = {
      findScreeningsByMovieIdAndDateRange:
        jest.fn<FindScreeningsByMovieIdAndDateRange>(),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        ListScreeningsByMovieAndDateService,
        {
          provide: ScreeningRepository,
          useValue: screeningRepository,
        },
      ],
    }).compile();

    service = moduleRef.get(ListScreeningsByMovieAndDateService);
  });

  it("groups screenings by screen.id, keeps repository order, and maps Seoul local startTime", async () => {
    screeningRepository.findScreeningsByMovieIdAndDateRange.mockResolvedValue([
      {
        id: "screening-1",
        startAt: new Date("2026-09-20T01:00:00.000Z"),
        screen: {
          id: SCREEN_1_ID,
          number: 1,
          floor: 2,
          screenType: "IMAX",
        },
      },
      {
        id: "screening-2",
        startAt: new Date("2026-09-20T04:30:00.000Z"),
        screen: {
          id: SCREEN_1_ID,
          number: 1,
          floor: 2,
          screenType: "IMAX",
        },
      },
      {
        id: "screening-3",
        startAt: new Date("2026-09-20T01:00:00.000Z"),
        screen: {
          id: SCREEN_2_ID,
          number: 2,
          floor: 3,
          screenType: "2D",
        },
      },
    ]);

    const result = await service.execute(MOVIE_ID, DATE);

    expect(
      screeningRepository.findScreeningsByMovieIdAndDateRange,
    ).toHaveBeenCalledWith(MOVIE_ID, RANGE_FROM, RANGE_TO);
    expect(result).toEqual({
      date: DATE,
      screens: [
        {
          screen: {
            id: SCREEN_1_ID,
            number: 1,
            floor: 2,
            screenType: "IMAX",
          },
          screenings: [
            { id: "screening-1", startTime: "10:00" },
            { id: "screening-2", startTime: "13:30" },
          ],
        },
        {
          screen: {
            id: SCREEN_2_ID,
            number: 2,
            floor: 3,
            screenType: "2D",
          },
          screenings: [{ id: "screening-3", startTime: "10:00" }],
        },
      ],
    });
    expect(result.screens.map((group) => group.screen.id)).toEqual([
      SCREEN_1_ID,
      SCREEN_2_ID,
    ]);
  });

  it("converts the calendar date to a half-open Asia/Seoul instant range", async () => {
    screeningRepository.findScreeningsByMovieIdAndDateRange.mockResolvedValue(
      [],
    );

    await service.execute(MOVIE_ID, DATE);

    const [, from, to] =
      screeningRepository.findScreeningsByMovieIdAndDateRange.mock.calls[0] ??
      [];

    expect(from).toEqual(RANGE_FROM);
    expect(to).toEqual(RANGE_TO);
    expect(from < new Date("2026-09-20T14:59:59.999Z")).toBe(true);
    expect(new Date("2026-09-20T14:59:59.999Z") < to).toBe(true);
    expect(new Date("2026-09-20T15:00:00.000Z") < to).toBe(false);
    expect(new Date("2026-09-20T15:00:00.000Z").getTime()).toBe(to.getTime());
  });

  it("returns an empty screens array when the date has no screenings", async () => {
    screeningRepository.findScreeningsByMovieIdAndDateRange.mockResolvedValue(
      [],
    );

    const result = await service.execute(MOVIE_ID, DATE);

    expect(result).toEqual({
      date: DATE,
      screens: [],
    });
  });
});
