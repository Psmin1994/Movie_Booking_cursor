import { Injectable } from "@nestjs/common";
import { Prisma } from "@movie-booking/database-prisma";
import { PrismaService } from "../../database/prisma.service.js";
import { PAYMENT_CANCELED_STATUS, PAYMENT_PAID_STATUS } from "../../payment/payment.constants.js";
import {
  BOOKING_CANCELLED_STATUS,
  BOOKING_CONFIRMED_STATUS,
  BOOKING_EXPIRED_STATUS,
  BOOKING_FAILED_STATUS,
  BOOKING_PENDING_STATUS,
  CANCEL_CONFIRMED_BOOKING_RESULT,
} from "../booking.constants.js";

type BookingTransaction = Prisma.TransactionClient;

export type BookingByIdAndUserId = {
  totalAmount: number;
  status: string;
  expiresAt: Date;
  paymentId: string | null;
};

export type CancelPendingBookingPayment = "none" | "canceled";

export type BookingForPendingCancel = {
  status: string;
  expiresAt: Date;
  payment: { id: string; status: string } | null;
};

export type CancelConfirmedBookingResult =
  | {
      result: typeof CANCEL_CONFIRMED_BOOKING_RESULT.CANCELLED;
      paymentId: string;
      amount: number;
    }
  | { result: typeof CANCEL_CONFIRMED_BOOKING_RESULT.NOT_FOUND }
  | { result: typeof CANCEL_CONFIRMED_BOOKING_RESULT.ALREADY_CANCELLED }
  | { result: typeof CANCEL_CONFIRMED_BOOKING_RESULT.NOT_CANCELLABLE }
  | { result: typeof CANCEL_CONFIRMED_BOOKING_RESULT.PAYMENT_NOT_PAID };

@Injectable()
export class BookingRepository {
  constructor(private readonly prisma: PrismaService) {}

  findBookingsByUserId(userId: string) {
    return this.prisma.client.booking.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        status: true,
        confirmedAt: true,
        screening: {
          select: {
            id: true,
            startAt: true,
            movie: { select: { id: true, title: true } },
            screen: {
              select: { id: true, number: true, floor: true, screenType: true },
            },
          },
        },
        bookingSeats: {
          orderBy: [{ screeningSeat: { seat: { row: "asc" } } }, { screeningSeat: { seat: { number: "asc" } } }],
          select: {
            screeningSeat: {
              select: {
                id: true,
                seat: { select: { row: true, number: true } },
              },
            },
          },
        },
      },
    });
  }

  findBookingDetailByIdAndUserId(bookingId: string, userId: string) {
    return this.prisma.client.booking.findFirst({
      where: { id: bookingId, userId },
      select: {
        id: true,
        status: true,
        createdAt: true,
        expiresAt: true,
        confirmedAt: true,
        cancelledAt: true,
        payment: {
          select: {
            id: true,
            orderId: true,
            amount: true,
            status: true,
            paidAt: true,
            refunds: {
              orderBy: { createdAt: "asc" },
              select: {
                id: true,
                amount: true,
                status: true,
                completedAt: true,
                failedAt: true,
              },
            },
          },
        },
        screening: {
          select: {
            id: true,
            startAt: true,
            movie: { select: { id: true, title: true } },
            screen: {
              select: { id: true, number: true, floor: true, screenType: true },
            },
          },
        },
        bookingSeats: {
          orderBy: [{ screeningSeat: { seat: { row: "asc" } } }, { screeningSeat: { seat: { number: "asc" } } }],
          select: {
            screeningSeat: {
              select: {
                id: true,
                seat: { select: { row: true, number: true } },
              },
            },
          },
        },
      },
    });
  }

  async lockBookingById(tx: BookingTransaction, bookingId: string): Promise<void> {
    // CreatePayment inserts Payment and ExpireBooking updates Booking.
    // Those writes lock different rows, so this lock is what makes the two commits mutually exclusive.
    await tx.$queryRaw`
      SELECT "id" FROM "Booking" WHERE "id" = ${bookingId} FOR UPDATE
    `;
  }

  async findBookingByIdAndUserId(
    tx: BookingTransaction,
    bookingId: string,
    userId: string,
  ): Promise<BookingByIdAndUserId | null> {
    const booking = await tx.booking.findFirst({
      where: {
        id: bookingId,
        userId,
      },
      select: {
        totalAmount: true,
        status: true,
        expiresAt: true,
        payment: { select: { id: true } },
      },
    });

    if (!booking) {
      return null;
    }

    return {
      totalAmount: booking.totalAmount,
      status: booking.status,
      expiresAt: booking.expiresAt,
      paymentId: booking.payment?.id ?? null,
    };
  }

  expirePendingBookingWithoutPayment(tx: BookingTransaction, bookingId: string, now: Date) {
    return tx.booking.updateMany({
      where: {
        id: bookingId,
        status: BOOKING_PENDING_STATUS,
        expiresAt: { lte: now },
        payment: { is: null },
      },
      data: {
        status: BOOKING_EXPIRED_STATUS,
      },
    });
  }

  expirePendingBooking(tx: BookingTransaction, bookingId: string, userId: string, now: Date) {
    return tx.booking.updateMany({
      where: {
        id: bookingId,
        userId,
        status: BOOKING_PENDING_STATUS,
        expiresAt: { lte: now },
      },
      data: {
        status: BOOKING_EXPIRED_STATUS,
      },
    });
  }

  cancelPendingBookingForReconciliation(
    tx: BookingTransaction,
    bookingId: string,
    userId: string,
    cancelledAt: Date,
  ) {
    return tx.booking.updateMany({
      where: {
        id: bookingId,
        userId,
        status: BOOKING_PENDING_STATUS,
      },
      data: {
        status: BOOKING_CANCELLED_STATUS,
        cancelledAt,
      },
    });
  }

  expirePendingBookingPastExpiry(tx: BookingTransaction, bookingId: string, now: Date) {
    return tx.booking.updateMany({
      where: {
        id: bookingId,
        status: BOOKING_PENDING_STATUS,
        expiresAt: { lte: now },
      },
      data: {
        status: BOOKING_EXPIRED_STATUS,
      },
    });
  }

  confirmPendingBooking(
    tx: BookingTransaction,
    bookingId: string,
    userId: string,
    confirmedAt: Date,
  ) {
    return tx.booking.updateMany({
      where: {
        id: bookingId,
        userId,
        status: BOOKING_PENDING_STATUS,
      },
      data: {
        status: BOOKING_CONFIRMED_STATUS,
        confirmedAt,
      },
    });
  }

  failPendingBooking(tx: BookingTransaction, bookingId: string, userId: string, failedAt: Date) {
    return tx.booking.updateMany({
      where: {
        id: bookingId,
        userId,
        status: BOOKING_PENDING_STATUS,
      },
      data: {
        status: BOOKING_FAILED_STATUS,
        failedAt,
      },
    });
  }

  async findExpiredPendingBookingIdsWithoutPayment(now: Date, limit: number): Promise<string[]> {
    const bookings = await this.prisma.client.booking.findMany({
      where: {
        status: BOOKING_PENDING_STATUS,
        expiresAt: { lte: now },
        payment: { is: null },
      },
      orderBy: { expiresAt: "asc" },
      take: limit,
      select: { id: true },
    });

    return bookings.map((booking) => booking.id);
  }

  createBooking(
    tx: BookingTransaction,
    data: {
      userId: string;
      screeningId: string;
      status: string;
      totalAmount: number;
      confirmedAt?: Date | null;
      expiresAt: Date;
    },
  ) {
    return tx.booking.create({
      data,
      select: {
        id: true,
        userId: true,
        screeningId: true,
        status: true,
        totalAmount: true,
        createdAt: true,
        confirmedAt: true,
      },
    });
  }

  createBookingSeats(tx: BookingTransaction, bookingId: string, screeningSeatIds: string[]) {
    return tx.bookingSeat.createMany({
      data: screeningSeatIds.map((screeningSeatId) => ({
        bookingId,
        screeningSeatId,
      })),
    });
  }

  findBookingForPendingCancel(
    tx: BookingTransaction,
    bookingId: string,
    userId: string,
  ): Promise<BookingForPendingCancel | null> {
    return tx.booking.findFirst({
      where: {
        id: bookingId,
        userId,
      },
      select: {
        status: true,
        expiresAt: true,
        payment: { select: { id: true, status: true } },
      },
    });
  }

  cancelPendingBooking(
    tx: BookingTransaction,
    bookingId: string,
    userId: string,
    now: Date,
    payment: CancelPendingBookingPayment,
  ) {
    return tx.booking.updateMany({
      where: {
        id: bookingId,
        userId,
        status: BOOKING_PENDING_STATUS,
        expiresAt: { gt: now },
        payment: payment === "canceled" ? { status: PAYMENT_CANCELED_STATUS } : { is: null },
      },
      data: {
        status: BOOKING_CANCELLED_STATUS,
        cancelledAt: now,
      },
    });
  }

  async cancelConfirmedBooking(
    tx: BookingTransaction,
    bookingId: string,
    userId: string,
  ): Promise<CancelConfirmedBookingResult> {
    const cancelled = await tx.booking.updateMany({
      where: {
        id: bookingId,
        userId,
        status: BOOKING_CONFIRMED_STATUS,
        payment: { status: PAYMENT_PAID_STATUS },
      },
      data: {
        status: BOOKING_CANCELLED_STATUS,
        cancelledAt: new Date(),
      },
    });

    if (cancelled.count === 1) {
      const payment = await tx.payment.findUnique({
        where: { bookingId },
        select: { id: true, amount: true },
      });

      if (!payment) {
        return { result: CANCEL_CONFIRMED_BOOKING_RESULT.NOT_FOUND };
      }

      return {
        result: CANCEL_CONFIRMED_BOOKING_RESULT.CANCELLED,
        paymentId: payment.id,
        amount: payment.amount,
      };
    }

    const booking = await tx.booking.findFirst({
      where: {
        id: bookingId,
        userId,
      },
      select: {
        status: true,
        payment: { select: { status: true } },
      },
    });

    if (!booking) {
      return { result: CANCEL_CONFIRMED_BOOKING_RESULT.NOT_FOUND };
    }

    if (booking.status === BOOKING_CANCELLED_STATUS) {
      return { result: CANCEL_CONFIRMED_BOOKING_RESULT.ALREADY_CANCELLED };
    }

    if (
      booking.status === BOOKING_PENDING_STATUS ||
      booking.status === BOOKING_FAILED_STATUS ||
      booking.status === BOOKING_EXPIRED_STATUS
    ) {
      return { result: CANCEL_CONFIRMED_BOOKING_RESULT.NOT_CANCELLABLE };
    }

    if (booking.status === BOOKING_CONFIRMED_STATUS && booking.payment?.status !== PAYMENT_PAID_STATUS) {
      return { result: CANCEL_CONFIRMED_BOOKING_RESULT.PAYMENT_NOT_PAID };
    }

    return { result: CANCEL_CONFIRMED_BOOKING_RESULT.NOT_FOUND };
  }

  findBookingSeatsByBookingId(tx: BookingTransaction, bookingId: string) {
    return tx.bookingSeat.findMany({
      where: { bookingId },
      select: { screeningSeatId: true },
    });
  }
}
