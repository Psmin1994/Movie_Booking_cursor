import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import type { AuthenticatedUser } from "../../auth/decorators/current-user.decorator.js";
import { PrismaService } from "../../database/prisma.service.js";
import { ScreeningRepository } from "../../screening/repository/screening.repository.js";
import { BOOKING_PAYMENT_WINDOW_MS, BOOKING_PENDING_STATUS, SEAT_PRICE } from "../booking.constants.js";
import { BookingRepository } from "../repository/booking.repository.js";
import { BookingResponseDto } from "../dto/booking-response.dto.js";
import { CreateBookingDto } from "../dto/create-booking.dto.js";

@Injectable()
export class CreateBookingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly screeningRepository: ScreeningRepository,
    private readonly bookingRepository: BookingRepository,
  ) {}

  async execute(user: AuthenticatedUser, dto: CreateBookingDto): Promise<BookingResponseDto> {
    return this.prisma.client.$transaction(async (tx) => {
      const screening = await this.screeningRepository.findScreeningById(dto.screeningId, tx);

      if (!screening) {
        throw new NotFoundException("상영을 찾을 수 없습니다.");
      }

      if (screening.startAt.getTime() <= Date.now()) {
        throw new ConflictException("이미 시작된 상영은 예약할 수 없습니다.");
      }

      const screeningSeats = await this.screeningRepository.findScreeningSeatsByIds(
        tx,
        dto.screeningId,
        dto.screeningSeatIds,
      );

      if (screeningSeats.length !== dto.screeningSeatIds.length) {
        throw new NotFoundException("좌석을 찾을 수 없습니다.");
      }

      const occupancy = await this.screeningRepository.occupyAvailableSeats(tx, dto.screeningId, dto.screeningSeatIds);

      if (occupancy.count !== dto.screeningSeatIds.length) {
        throw new ConflictException("이미 예매된 좌석이 포함되어 있습니다.");
      }

      const totalAmount = dto.screeningSeatIds.length * SEAT_PRICE;

      const booking = await this.bookingRepository.createBooking(tx, {
        userId: user.id,
        screeningId: dto.screeningId,
        status: BOOKING_PENDING_STATUS,
        totalAmount,
        confirmedAt: null,
        expiresAt: new Date(Date.now() + BOOKING_PAYMENT_WINDOW_MS),
      });

      await this.bookingRepository.createBookingSeats(tx, booking.id, dto.screeningSeatIds);

      return {
        id: booking.id,
      };
    });
  }
}
