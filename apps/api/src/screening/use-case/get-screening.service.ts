import { Injectable, NotFoundException } from "@nestjs/common";
import { GetScreeningResponseDto } from "../dto/get-screening-response.dto.js";
import { ScreeningRepository } from "../repository/screening.repository.js";

@Injectable()
export class GetScreeningService {
  constructor(private readonly screeningRepository: ScreeningRepository) {}

  async execute(id: string): Promise<GetScreeningResponseDto> {
    const screening = await this.screeningRepository.findScreeningDetailById(id);

    if (!screening) {
      throw new NotFoundException("상영을 찾을 수 없습니다.");
    }

    return this.toGetScreeningResponse(screening);
  }

  private toGetScreeningResponse(
    screening: NonNullable<Awaited<ReturnType<ScreeningRepository["findScreeningDetailById"]>>>,
  ): GetScreeningResponseDto {
    return {
      id: screening.id,
      startAt: screening.startAt.toISOString(),
      movie: {
        id: screening.movie.id,
        title: screening.movie.title,
        posterUrl: screening.movie.posterUrl,
        runtime: screening.movie.runtime,
      },
      screen: {
        id: screening.screen.id,
        number: screening.screen.number,
        floor: screening.screen.floor,
        screenType: screening.screen.screenType,
      },
      seats: screening.screeningSeats.map((screeningSeat) => ({
        id: screeningSeat.id,
        seatId: screeningSeat.seat.id,
        row: screeningSeat.seat.row,
        number: screeningSeat.seat.number,
        seatType: screeningSeat.seat.seatType,
        status: screeningSeat.status,
      })),
    };
  }
}
