import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import {
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from "@nestjs/swagger";
import { CreateScreeningService } from "../use-case/create-screening.service.js";
import { CreateScreeningDto } from "../dto/create-screening.dto.js";
import { GetScreeningSeatsResponseDto } from "../dto/get-screening-seats-response.dto.js";
import { GetScreeningResponseDto } from "../dto/get-screening-response.dto.js";
import { ScreeningResponseDto } from "../dto/screening-response.dto.js";
import { GetScreeningSeatsService } from "../use-case/get-screening-seats.service.js";
import { GetScreeningService } from "../use-case/get-screening.service.js";

@ApiTags("screenings")
@Controller("screenings")
export class ScreeningController {
  constructor(
    private readonly createScreeningService: CreateScreeningService,
    private readonly getScreeningService: GetScreeningService,
    private readonly getScreeningSeatsService: GetScreeningSeatsService,
  ) {}

  @Post()
  @ApiOperation({ summary: "상영 생성" })
  @ApiBody({ type: CreateScreeningDto })
  @ApiCreatedResponse({ type: ScreeningResponseDto })
  @ApiNotFoundResponse({ description: "영화 또는 상영관을 찾을 수 없습니다." })
  @ApiConflictResponse({
    description: "해당 상영관에 같은 시작 시각의 상영이 이미 있습니다.",
  })
  createScreening(@Body() dto: CreateScreeningDto): Promise<ScreeningResponseDto> {
    return this.createScreeningService.execute(dto);
  }

  @Get(":screeningId/seats")
  @ApiOperation({ summary: "상영 좌석 현황 조회" })
  @ApiOkResponse({ type: GetScreeningSeatsResponseDto })
  @ApiNotFoundResponse({ description: "상영을 찾을 수 없습니다." })
  @ApiConflictResponse({
    description: "이미 시작된 상영의 좌석은 조회할 수 없습니다.",
  })
  getScreeningSeats(@Param("screeningId") screeningId: string): Promise<GetScreeningSeatsResponseDto> {
    return this.getScreeningSeatsService.execute(screeningId);
  }

  @Get(":id")
  @ApiOperation({ summary: "상영 조회" })
  @ApiOkResponse({ type: GetScreeningResponseDto })
  @ApiNotFoundResponse({ description: "상영을 찾을 수 없습니다." })
  getScreening(@Param("id") id: string): Promise<GetScreeningResponseDto> {
    return this.getScreeningService.execute(id);
  }
}
