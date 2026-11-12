import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@movie-booking/database-prisma";
import type { AuthenticatedUser } from "../../auth/decorators/current-user.decorator.js";
import { BOOKING_PENDING_STATUS } from "../../booking/booking.constants.js";
import { BookingRepository } from "../../booking/repository/booking.repository.js";
import { PrismaService } from "../../database/prisma.service.js";
import { createPaymentOrderId } from "../create-payment-order-id.js";
import { CreatePaymentDto } from "../dto/create-payment.dto.js";
import { CreatePaymentResponseDto } from "../dto/create-payment-response.dto.js";
import { PaymentRepository } from "../repository/payment.repository.js";

@Injectable()
export class CreatePaymentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bookingRepository: BookingRepository,
    private readonly paymentRepository: PaymentRepository,
  ) {}

  async execute(
    user: AuthenticatedUser,
    dto: CreatePaymentDto,
  ): Promise<CreatePaymentResponseDto> {
    return this.prisma.client.$transaction(async (tx) => {
      await this.bookingRepository.lockBookingById(tx, dto.bookingId);

      const booking = await this.bookingRepository.findBookingByIdAndUserId(
        tx,
        dto.bookingId,
        user.id,
      );

      if (!booking) {
        throw new NotFoundException("예매를 찾을 수 없습니다.");
      }

      if (booking.paymentId) {
        throw new ConflictException("이미 결제가 생성된 예매입니다.");
      }

      if (
        booking.status !== BOOKING_PENDING_STATUS ||
        booking.expiresAt.getTime() <= Date.now()
      ) {
        throw new ConflictException("결제할 수 없는 예매입니다.");
      }

      try {
        const payment = await this.paymentRepository.createPendingPayment(
          tx,
          dto.bookingId,
          booking.totalAmount,
          createPaymentOrderId(),
        );

        return {
          id: payment.id,
          orderId: payment.orderId,
          amount: payment.amount,
          status: payment.status,
        };
      } catch (error) {
        if (isPaymentBookingUniqueViolation(error)) {
          throw new ConflictException("이미 결제가 생성된 예매입니다.");
        }

        throw error;
      }
    });
  }
}

function isPaymentBookingUniqueViolation(error: unknown): boolean {
  if (
    !(error instanceof Prisma.PrismaClientKnownRequestError) ||
    error.code !== "P2002"
  ) {
    return false;
  }

  const target = error.meta?.target;

  if (target == null) {
    return false;
  }

  if (typeof target === "string") {
    return target.includes("bookingId");
  }

  if (Array.isArray(target)) {
    return target.includes("bookingId");
  }

  return false;
}
