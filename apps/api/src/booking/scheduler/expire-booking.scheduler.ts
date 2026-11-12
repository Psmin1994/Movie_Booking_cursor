import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { BookingRepository } from "../repository/booking.repository.js";
import { ExpireBookingService } from "../use-case/expire-booking.service.js";

const EXPIRE_BOOKING_BATCH_LIMIT = 100;

@Injectable()
export class ExpireBookingScheduler {
  private readonly logger = new Logger(ExpireBookingScheduler.name);

  constructor(
    private readonly bookingRepository: BookingRepository,
    private readonly expireBookingService: ExpireBookingService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async expireDueBookings(): Promise<void> {
    const now = new Date(Date.now());
    const bookingIds = await this.bookingRepository.findExpiredPendingBookingIdsWithoutPayment(
      now,
      EXPIRE_BOOKING_BATCH_LIMIT,
    );

    for (const bookingId of bookingIds) {
      try {
        await this.expireBookingService.execute(bookingId);
      } catch (error) {
        const stack = error instanceof Error ? error.stack : String(error);
        this.logger.error(`Failed to expire booking ${bookingId}`, stack);
      }
    }
  }
}
