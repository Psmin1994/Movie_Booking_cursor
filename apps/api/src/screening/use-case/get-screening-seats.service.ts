import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { GetScreeningSeatsResponseDto } from "../dto/get-screening-seats-response.dto.js";
import { ScreeningRepository } from "../repository/screening.repository.js";

@Injectable()
export class GetScreeningSeatsService {
  constructor(private readonly screeningRepository: ScreeningRepository) {}

  async execute(screeningId: string): Promise<GetScreeningSeatsResponseDto> {
    const screening = await this.screeningRepository.findScreeningById(screeningId);

    if (!screening) {
      throw new NotFoundException("상영을 찾을 수 없습니다.");
    }

    if (screening.startAt.getTime() <= Date.now()) {
      throw new ConflictException(
        "이미 시작된 상영의 좌석은 조회할 수 없습니다.",
      );
    }

    const screeningSeats =
      await this.screeningRepository.findScreeningSeatsByScreeningId(screeningId);

    return this.toGetScreeningSeatsResponse(screeningSeats);
  }

  private toGetScreeningSeatsResponse(
    screeningSeats: Awaited<
      ReturnType<ScreeningRepository["findScreeningSeatsByScreeningId"]>
    >,
  ): GetScreeningSeatsResponseDto {
    return {
      seats: screeningSeats.map((screeningSeat) => ({
        id: screeningSeat.id,
        row: screeningSeat.seat.row,
        number: screeningSeat.seat.number,
        status: screeningSeat.status,
      })),
    };
  }
}
