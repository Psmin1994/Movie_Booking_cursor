import { Injectable } from "@nestjs/common";
import { DateTime } from "luxon";
import { ListScreeningsByMovieAndDateResponseDto } from "../dto/list-screenings-by-movie-and-date-response.dto.js";
import { SERVICE_TIMEZONE } from "../screening.constants.js";
import { ScreeningRepository } from "../repository/screening.repository.js";

@Injectable()
export class ListScreeningsByMovieAndDateService {
  constructor(private readonly screeningRepository: ScreeningRepository) {}

  async execute(
    movieId: string,
    date: string,
  ): Promise<ListScreeningsByMovieAndDateResponseDto> {
    const { from, to } = toSeoulDayRange(date);
    const screenings =
      await this.screeningRepository.findScreeningsByMovieIdAndDateRange(
        movieId,
        from,
        to,
      );

    const screens = new Map<
      string,
      ListScreeningsByMovieAndDateResponseDto["screens"][number]
    >();

    for (const screening of screenings) {
      let group = screens.get(screening.screen.id);

      if (!group) {
        group = {
          screen: {
            id: screening.screen.id,
            number: screening.screen.number,
            floor: screening.screen.floor,
            screenType: screening.screen.screenType,
          },
          screenings: [],
        };
        screens.set(screening.screen.id, group);
      }

      group.screenings.push({
        id: screening.id,
        startTime: toSeoulStartTime(screening.startAt),
      });
    }

    return {
      date,
      screens: [...screens.values()],
    };
  }
}

function toSeoulDayRange(date: string): { from: Date; to: Date } {
  const startOfDay = DateTime.fromISO(date, {
    zone: SERVICE_TIMEZONE,
  }).startOf("day");

  return {
    from: startOfDay.toJSDate(),
    to: startOfDay.plus({ days: 1 }).toJSDate(),
  };
}

function toSeoulStartTime(startAt: Date): string {
  return DateTime.fromJSDate(startAt, { zone: SERVICE_TIMEZONE }).toFormat(
    "HH:mm",
  );
}
