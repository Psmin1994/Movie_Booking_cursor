import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import type { Prisma } from "@movie-booking/database-prisma";
import type { AuthenticatedUser } from "../../auth/decorators/current-user.decorator.js";
import { PrismaService } from "../../database/prisma.service.js";
import { cancelPendingPayment } from "../../payment/repository/payment.repository.js";
import { PAYMENT_PENDING_STATUS } from "../../payment/payment.constants.js";
import { RefundRepository } from "../../refund/repository/refund.repository.js";
import { ProcessRefundService } from "../../refund/use-case/process-refund.service.js";
import {
  BOOKING_PENDING_STATUS,
  CANCEL_CONFIRMED_BOOKING_RESULT,
  CANCEL_PENDING_BOOKING_RESULT,
} from "../booking.constants.js";
import { BookingRepository } from "../repository/booking.repository.js";
import { BookingSeatReleaseService } from "./booking-seat-release.service.js";

type CancelPendingBookingResult =
  | { result: typeof CANCEL_PENDING_BOOKING_RESULT.CANCELLED }
  | { result: typeof CANCEL_PENDING_BOOKING_RESULT.NOT_FOUND }
  | { result: typeof CANCEL_PENDING_BOOKING_RESULT.NOT_CANCELLABLE }
  | { result: typeof CANCEL_PENDING_BOOKING_RESULT.INCOMPLETE };

@Injectable()
export class CancelBookingService {
  private readonly logger = new Logger(CancelBookingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly bookingRepository: BookingRepository,
    private readonly bookingSeatReleaseService: BookingSeatReleaseService,
    private readonly refundRepository: RefundRepository,
    private readonly processRefundService: ProcessRefundService,
  ) {}

  async cancelPending(user: AuthenticatedUser, bookingId: string): Promise<void> {
    await this.prisma.client.$transaction(async (tx) => {
      await this.bookingRepository.lockBookingById(tx, bookingId);

      const cancelResult = await this.applyPendingCancel(tx, bookingId, user.id);

      if (cancelResult.result === CANCEL_PENDING_BOOKING_RESULT.NOT_FOUND) {
        throw new NotFoundException("예매를 찾을 수 없습니다.");
      }

      if (cancelResult.result === CANCEL_PENDING_BOOKING_RESULT.NOT_CANCELLABLE) {
        throw new ConflictException("취소할 수 없는 예매입니다.");
      }

      if (cancelResult.result === CANCEL_PENDING_BOOKING_RESULT.INCOMPLETE) {
        throw new InternalServerErrorException();
      }

      await this.bookingSeatReleaseService.release(tx, bookingId);
    });
  }

  async cancelConfirmed(user: AuthenticatedUser, bookingId: string): Promise<void> {
    const refundId = await this.prisma.client.$transaction(async (tx) => {
      const cancelResult = await this.bookingRepository.cancelConfirmedBooking(tx, bookingId, user.id);

      if (cancelResult.result === CANCEL_CONFIRMED_BOOKING_RESULT.NOT_FOUND) {
        throw new NotFoundException("예매를 찾을 수 없습니다.");
      }

      if (cancelResult.result === CANCEL_CONFIRMED_BOOKING_RESULT.ALREADY_CANCELLED) {
        throw new ConflictException("이미 취소된 예매입니다.");
      }

      if (
        cancelResult.result === CANCEL_CONFIRMED_BOOKING_RESULT.NOT_CANCELLABLE ||
        cancelResult.result === CANCEL_CONFIRMED_BOOKING_RESULT.PAYMENT_NOT_PAID
      ) {
        throw new ConflictException("취소할 수 없는 예매입니다.");
      }

      await this.bookingSeatReleaseService.release(tx, bookingId);

      const refund = await this.refundRepository.createPendingRefund(
        tx,
        cancelResult.paymentId,
        cancelResult.amount,
      );

      return refund.id;
    });

    this.startProcessRefund(refundId);
  }

  private startProcessRefund(refundId: string): void {
    void this.processRefundService.execute(refundId).catch((error: unknown) => {
      const stack = error instanceof Error ? error.stack : String(error);
      this.logger.error(`Failed to process refund ${refundId}`, stack);
    });
  }

  private async applyPendingCancel(
    tx: Prisma.TransactionClient,
    bookingId: string,
    userId: string,
  ): Promise<CancelPendingBookingResult> {
    const now = new Date(Date.now());
    const booking = await this.bookingRepository.findBookingForPendingCancel(tx, bookingId, userId);

    if (!booking) {
      return { result: CANCEL_PENDING_BOOKING_RESULT.NOT_FOUND };
    }

    const payment = booking.payment;
    const cancellable =
      booking.status === BOOKING_PENDING_STATUS &&
      booking.expiresAt.getTime() > now.getTime() &&
      (payment === null || payment.status === PAYMENT_PENDING_STATUS);

    if (!cancellable) {
      return { result: CANCEL_PENDING_BOOKING_RESULT.NOT_CANCELLABLE };
    }

    if (payment) {
      const canceled = await cancelPendingPayment(tx, payment.id, bookingId, userId, now);

      if (canceled.count !== 1) {
        return { result: CANCEL_PENDING_BOOKING_RESULT.NOT_CANCELLABLE };
      }
    }

    const cancelled = await this.bookingRepository.cancelPendingBooking(
      tx,
      bookingId,
      userId,
      now,
      payment ? "canceled" : "none",
    );

    if (cancelled.count !== 1) {
      return { result: CANCEL_PENDING_BOOKING_RESULT.INCOMPLETE };
    }

    return { result: CANCEL_PENDING_BOOKING_RESULT.CANCELLED };
  }
}
