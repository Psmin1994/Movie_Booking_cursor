import { Controller, Get, Param } from "@nestjs/common";
import {
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from "@nestjs/swagger";
import { MovieDetailResponseDto } from "../dto/movie-detail-response.dto.js";
import { MovieSummaryResponseDto } from "../dto/movie-summary-response.dto.js";
import { MovieService } from "../use-case/movie.service.js";

@ApiTags("movies")
@Controller("movies")
export class MovieController {
  constructor(private readonly movieService: MovieService) {}

  @Get()
  @ApiOperation({ summary: "영화 목록 조회" })
  @ApiOkResponse({ type: MovieSummaryResponseDto, isArray: true })
  getMovies(): Promise<MovieSummaryResponseDto[]> {
    return this.movieService.getMovies();
  }

  @Get(":id")
  @ApiOperation({ summary: "영화 상세 조회" })
  @ApiOkResponse({ type: MovieDetailResponseDto })
  @ApiNotFoundResponse({ description: "영화를 찾을 수 없습니다." })
  getMovie(@Param("id") id: string): Promise<MovieDetailResponseDto> {
    return this.movieService.getMovie(id);
  }
}
