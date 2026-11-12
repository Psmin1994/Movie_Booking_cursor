import { Injectable, InternalServerErrorException } from "@nestjs/common";
import { BookingRepository } from "../../booking/repository/booking.repository.js";
import { BookingSeatReleaseService } from "../../booking/use-case/booking-seat-release.service.js";
import { PrismaService } from "../../database/prisma.service.js";
import { RECOVER_AUTHORIZING_PAYMENT_RESULT } from "../payment.constants.js";
import { PaymentRepository } from "../repository/payment.repository.js";
import { ReconcilePaymentRepository } from "../repository/reconcile-payment.repository.js";

export type RecoverAuthorizingPaymentResult =
  | { result: typeof RECOVER_AUTHORIZING_PAYMENT_RESULT.RECONCILIATION_REQUIRED }
  | { result: typeof RECOVER_AUTHORIZING_PAYMENT_RESULT.NOT_ELIGIBLE };

// 결제 요청 시간이 만료된 결제를 조회하고, 결제 상태를 업데이트하는 서비스
@Injectable()
export class RecoverAuthorizingPaymentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly paymentRepository: PaymentRepository,
    private readonly bookingRepository: BookingRepository,
    private readonly bookingSeatReleaseService: BookingSeatReleaseService,
    private readonly reconcilePaymentRepository: ReconcilePaymentRepository,
  ) {}

  async execute(paymentId: string): Promise<RecoverAuthorizingPaymentResult> {
    return this.prisma.client.$transaction(async (tx) => {
      const now = new Date(Date.now());
      const recovered = await this.paymentRepository.recoverAuthorizingPaymentPastDeadline(tx, paymentId, now);

      if (recovered.count === 0) {
        return { result: RECOVER_AUTHORIZING_PAYMENT_RESULT.NOT_ELIGIBLE };
      }

      if (recovered.count !== 1 || recovered.bookingId === null || recovered.userId === null) {
        throw new InternalServerErrorException();
      }

      const bookingCancelled = await this.bookingRepository.cancelPendingBookingForReconciliation(
        tx,
        recovered.bookingId,
        recovered.userId,
        now,
      );

      if (bookingCancelled.count !== 1) {
        throw new InternalServerErrorException();
      }

      await this.bookingSeatReleaseService.release(tx, recovered.bookingId);
      await this.reconcilePaymentRepository.createOpen(tx, paymentId, now);

      return { result: RECOVER_AUTHORIZING_PAYMENT_RESULT.RECONCILIATION_REQUIRED };
    });
  }
}
