import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";
import { CurrentUser } from "../../auth/decorators/current-user.decorator.js";
import type { AuthenticatedUser } from "../../auth/decorators/current-user.decorator.js";
import { JwtAuthGuard } from "../../auth/guard/jwt-auth.guard.js";
import { CancelBookingService } from "../use-case/cancel-booking.service.js";
import { CreateBookingService } from "../use-case/create-booking.service.js";
import { CreateBookingDto } from "../dto/create-booking.dto.js";
import { BookingResponseDto } from "../dto/booking-response.dto.js";
import { GetBookingDetailResponseDto } from "../dto/get-booking-detail-response.dto.js";
import { GetMyBookingResponseDto } from "../dto/get-my-bookings-response.dto.js";
import { SelectBookingService } from "../use-case/select-booking.service.js";

@ApiTags("bookings")
@Controller("bookings")
export class BookingController {
  constructor(
    private readonly createBookingService: CreateBookingService,
    private readonly selectBookingService: SelectBookingService,
    private readonly cancelBookingService: CancelBookingService,
  ) {}

  @Get()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: "내 예매 목록 조회" })
  @ApiOkResponse({ type: GetMyBookingResponseDto, isArray: true })
  @ApiUnauthorizedResponse({ description: "인증 필요" })
  getMyBookings(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<GetMyBookingResponseDto[]> {
    return this.selectBookingService.getMyBookings(user);
  }

  @Get(":bookingId")
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: "내 예매 상세 조회" })
  @ApiOkResponse({ type: GetBookingDetailResponseDto })
  @ApiUnauthorizedResponse({ description: "인증 필요" })
  @ApiNotFoundResponse({ description: "예매를 찾을 수 없습니다." })
  getBookingDetail(
    @CurrentUser() user: AuthenticatedUser,
    @Param("bookingId") bookingId: string,
  ): Promise<GetBookingDetailResponseDto> {
    return this.selectBookingService.getBookingDetail(user, bookingId);
  }

  @Post()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: "예매 생성" })
  @ApiBody({ type: CreateBookingDto })
  @ApiCreatedResponse({ type: BookingResponseDto })
  @ApiUnauthorizedResponse({ description: "인증 필요" })
  createBooking(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateBookingDto,
  ): Promise<BookingResponseDto> {
    return this.createBookingService.execute(user, dto);
  }

  @Post(":bookingId/cancel")
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "예매 취소" })
  @ApiNoContentResponse()
  @ApiUnauthorizedResponse({ description: "인증 필요" })
  @ApiNotFoundResponse({ description: "예매를 찾을 수 없습니다." })
  @ApiConflictResponse({
    description: "이미 취소된 예매입니다. 또는 취소할 수 없는 예매입니다.",
  })
  cancelBooking(
    @CurrentUser() user: AuthenticatedUser,
    @Param("bookingId") bookingId: string,
  ): Promise<void> {
    return this.cancelBookingService.cancelConfirmed(user, bookingId);
  }

  @Post(":bookingId/cancel-pending")
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "결제 전 예매 취소" })
  @ApiNoContentResponse()
  @ApiUnauthorizedResponse({ description: "인증 필요" })
  @ApiNotFoundResponse({ description: "예매를 찾을 수 없습니다." })
  @ApiConflictResponse({ description: "취소할 수 없는 예매입니다." })
  cancelPendingBooking(
    @CurrentUser() user: AuthenticatedUser,
    @Param("bookingId") bookingId: string,
  ): Promise<void> {
    return this.cancelBookingService.cancelPending(user, bookingId);
  }
}
