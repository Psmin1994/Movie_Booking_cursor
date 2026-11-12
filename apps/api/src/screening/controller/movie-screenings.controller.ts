import { Controller, Get, Param, Query } from "@nestjs/common";
import {
  ApiBadRequestResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from "@nestjs/swagger";
import { ListScreeningsByMovieAndDateQueryDto } from "../dto/list-screenings-by-movie-and-date-query.dto.js";
import { ListScreeningsByMovieAndDateResponseDto } from "../dto/list-screenings-by-movie-and-date-response.dto.js";
import { ListScreeningsByMovieAndDateService } from "../use-case/list-screenings-by-movie-and-date.service.js";

@ApiTags("screenings")
@Controller("movies")
export class MovieScreeningsController {
  constructor(
    private readonly listScreeningsByMovieAndDateService: ListScreeningsByMovieAndDateService,
  ) {}

  @Get(":movieId/screenings")
  @ApiOperation({ summary: "영화 날짜별 상영 목록 조회" })
  @ApiOkResponse({ type: ListScreeningsByMovieAndDateResponseDto })
  @ApiBadRequestResponse({
    description: "date가 YYYY-MM-DD 형식의 실제 calendar date가 아닙니다.",
  })
  listScreeningsByMovieAndDate(
    @Param("movieId") movieId: string,
    @Query() query: ListScreeningsByMovieAndDateQueryDto,
  ): Promise<ListScreeningsByMovieAndDateResponseDto> {
    return this.listScreeningsByMovieAndDateService.execute(movieId, query.date);
  }
}
