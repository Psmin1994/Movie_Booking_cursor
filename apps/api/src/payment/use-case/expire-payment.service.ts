import { Injectable, InternalServerErrorException } from "@nestjs/common";
import { BookingRepository } from "../../booking/repository/booking.repository.js";
import { BookingSeatReleaseService } from "../../booking/use-case/booking-seat-release.service.js";
import { PrismaService } from "../../database/prisma.service.js";
import { EXPIRE_DUE_PAYMENT_RESULT } from "../payment.constants.js";
import { PaymentRepository } from "../repository/payment.repository.js";

export type ExpireDuePaymentResult =
  | { result: typeof EXPIRE_DUE_PAYMENT_RESULT.EXPIRED }
  | { result: typeof EXPIRE_DUE_PAYMENT_RESULT.NOT_ELIGIBLE };

@Injectable()
export class ExpirePaymentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly paymentRepository: PaymentRepository,
    private readonly bookingRepository: BookingRepository,
    private readonly bookingSeatReleaseService: BookingSeatReleaseService,
  ) {}

  async execute(paymentId: string): Promise<ExpireDuePaymentResult> {
    return this.prisma.client.$transaction(async (tx) => {
      const now = new Date(Date.now());
      const expired = await this.paymentRepository.expirePendingPaymentPastExpiry(tx, paymentId, now);

      if (expired.count === 0) {
        return { result: EXPIRE_DUE_PAYMENT_RESULT.NOT_ELIGIBLE };
      }

      if (expired.count !== 1 || expired.bookingId === null) {
        throw new InternalServerErrorException();
      }

      const bookingExpired = await this.bookingRepository.expirePendingBookingPastExpiry(
        tx,
        expired.bookingId,
        now,
      );

      if (bookingExpired.count !== 1) {
        throw new InternalServerErrorException();
      }

      await this.bookingSeatReleaseService.release(tx, expired.bookingId);

      return { result: EXPIRE_DUE_PAYMENT_RESULT.EXPIRED };
    });
  }
}
