import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../database/prisma.service.js";
import { EXPIRE_BOOKING_RESULT } from "../booking.constants.js";
import { BookingRepository } from "../repository/booking.repository.js";
import { BookingSeatReleaseService } from "./booking-seat-release.service.js";

export type ExpireBookingResult =
  | { result: typeof EXPIRE_BOOKING_RESULT.EXPIRED }
  | { result: typeof EXPIRE_BOOKING_RESULT.NOT_ELIGIBLE };

@Injectable()
export class ExpireBookingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bookingRepository: BookingRepository,
    private readonly bookingSeatReleaseService: BookingSeatReleaseService,
  ) {}

  async execute(bookingId: string): Promise<ExpireBookingResult> {
    return this.prisma.client.$transaction(async (tx) => {
      await this.bookingRepository.lockBookingById(tx, bookingId);

      const expired = await this.bookingRepository.expirePendingBookingWithoutPayment(
        tx,
        bookingId,
        new Date(Date.now()),
      );

      if (expired.count !== 1) {
        return { result: EXPIRE_BOOKING_RESULT.NOT_ELIGIBLE };
      }

      await this.bookingSeatReleaseService.release(tx, bookingId);

      return { result: EXPIRE_BOOKING_RESULT.EXPIRED };
    });
  }
}
