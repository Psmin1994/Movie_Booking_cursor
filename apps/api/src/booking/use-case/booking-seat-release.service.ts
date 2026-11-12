import { Injectable, InternalServerErrorException } from "@nestjs/common";
import type { Prisma } from "@movie-booking/database-prisma";
import { ScreeningRepository } from "../../screening/repository/screening.repository.js";
import { BookingRepository } from "../repository/booking.repository.js";

@Injectable()
export class BookingSeatReleaseService {
  constructor(
    private readonly bookingRepository: BookingRepository,
    private readonly screeningRepository: ScreeningRepository,
  ) {}

  async release(tx: Prisma.TransactionClient, bookingId: string): Promise<void> {
    const bookingSeats = await this.bookingRepository.findBookingSeatsByBookingId(tx, bookingId);
    const screeningSeatIds = bookingSeats.map((bookingSeat) => bookingSeat.screeningSeatId);

    if (screeningSeatIds.length === 0) {
      return;
    }

    const released = await this.screeningRepository.releaseBookedSeats(tx, screeningSeatIds);

    if (released.count !== screeningSeatIds.length) {
      throw new InternalServerErrorException();
    }
  }
}
