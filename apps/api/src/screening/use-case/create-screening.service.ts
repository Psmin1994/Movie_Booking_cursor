import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@movie-booking/database-prisma";
import { PrismaService } from "../../database/prisma.service.js";
import { MovieRepository } from "../../movie/repository/movie.repository.js";
import { CreateScreeningDto } from "../dto/create-screening.dto.js";
import { ScreeningResponseDto } from "../dto/screening-response.dto.js";
import { SCREENING_SEAT_INITIAL_STATUS } from "../screening.constants.js";
import { ScreeningRepository } from "../repository/screening.repository.js";

@Injectable()
export class CreateScreeningService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly movieRepository: MovieRepository,
    private readonly screeningRepository: ScreeningRepository,
  ) {}

  async execute(dto: CreateScreeningDto): Promise<ScreeningResponseDto> {
    return this.prisma.client.$transaction(async (tx) => {
      const movieExists = await this.movieRepository.existsById(dto.movieId, tx);

      if (!movieExists) {
        throw new NotFoundException("영화를 찾을 수 없습니다.");
      }

      const screen = await this.screeningRepository.findScreenById(
        tx,
        dto.screenId,
      );

      if (!screen) {
        throw new NotFoundException("상영관을 찾을 수 없습니다.");
      }

      const seats = await this.screeningRepository.findSeatsByScreenId(
        tx,
        dto.screenId,
      );

      try {
        const screening = await this.screeningRepository.createScreening(tx, {
          movieId: dto.movieId,
          screenId: dto.screenId,
          startAt: new Date(dto.startAt),
        });

        await this.screeningRepository.createScreeningSeats(tx, {
          screeningId: screening.id,
          seatIds: seats.map((seat) => seat.id),
          status: SCREENING_SEAT_INITIAL_STATUS,
        });

        return {
          id: screening.id,
          movieId: screening.movieId,
          screenId: screening.screenId,
          startAt: screening.startAt.toISOString(),
        };
      } catch (error) {
        if (isScreeningScheduleUniqueViolation(error)) {
          throw new ConflictException(
            "해당 상영관에 같은 시작 시각의 상영이 이미 있습니다.",
          );
        }

        throw error;
      }
    });
  }
}

function isScreeningScheduleUniqueViolation(error: unknown): boolean {
  if (
    !(error instanceof Prisma.PrismaClientKnownRequestError) ||
    error.code !== "P2002"
  ) {
    return false;
  }

  const target = error.meta?.target;

  if (target == null) {
    return false;
  }

  if (typeof target === "string") {
    return target.includes("screenId") && target.includes("startAt");
  }

  if (Array.isArray(target)) {
    return target.includes("screenId") && target.includes("startAt");
  }

  return false;
}
