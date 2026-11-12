import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { DatabaseModule } from "../database/database.module.js";
import { RefundModule } from "../refund/refund.module.js";
import { ScreeningModule } from "../screening/screening.module.js";
import { BookingController } from "./controller/booking.controller.js";
import { BookingRepository } from "./repository/booking.repository.js";
import { BookingSeatReleaseService } from "./use-case/booking-seat-release.service.js";
import { CancelBookingService } from "./use-case/cancel-booking.service.js";
import { CreateBookingService } from "./use-case/create-booking.service.js";
import { ExpireBookingScheduler } from "./scheduler/expire-booking.scheduler.js";
import { ExpireBookingService } from "./use-case/expire-booking.service.js";
import { SelectBookingService } from "./use-case/select-booking.service.js";

@Module({
  imports: [DatabaseModule, AuthModule, ScreeningModule, RefundModule],
  controllers: [BookingController],
  providers: [
    BookingSeatReleaseService,
    CancelBookingService,
    CreateBookingService,
    ExpireBookingScheduler,
    ExpireBookingService,
    SelectBookingService,
    BookingRepository,
  ],
  exports: [BookingRepository, BookingSeatReleaseService, ExpireBookingService],
})
export class BookingModule {}
