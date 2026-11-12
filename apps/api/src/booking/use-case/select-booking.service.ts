import { Injectable, NotFoundException } from "@nestjs/common";
import type { AuthenticatedUser } from "../../auth/decorators/current-user.decorator.js";
import { GetBookingDetailResponseDto } from "../dto/get-booking-detail-response.dto.js";
import { GetMyBookingResponseDto } from "../dto/get-my-bookings-response.dto.js";
import { BookingRepository } from "../repository/booking.repository.js";

type SelectedBookingRelations = {
  screening: {
    id: string;
    startAt: Date;
    movie: { id: string; title: string };
    screen: {
      id: string;
      number: number;
      floor: number;
      screenType: string;
    };
  };
  bookingSeats: Array<{
    screeningSeat: {
      id: string;
      seat: { row: string; number: number };
    };
  }>;
};

@Injectable()
export class SelectBookingService {
  constructor(private readonly bookingRepository: BookingRepository) {}

  async getBookingDetail(
    user: AuthenticatedUser,
    bookingId: string,
  ): Promise<GetBookingDetailResponseDto> {
    const booking = await this.bookingRepository.findBookingDetailByIdAndUserId(
      bookingId,
      user.id,
    );

    if (!booking) {
      throw new NotFoundException("예매를 찾을 수 없습니다.");
    }

    return {
      id: booking.id,
      status: booking.status,
      createdAt: booking.createdAt.toISOString(),
      expiresAt: booking.expiresAt.toISOString(),
      confirmedAt: booking.confirmedAt?.toISOString() ?? null,
      cancelledAt: booking.cancelledAt?.toISOString() ?? null,
      ...this.toBookingRelations(booking),
      payment: booking.payment
        ? {
            id: booking.payment.id,
            orderId: booking.payment.orderId,
            amount: booking.payment.amount,
            status: booking.payment.status,
            paidAt: booking.payment.paidAt?.toISOString() ?? null,
            refunds: booking.payment.refunds.map((refund) => ({
              id: refund.id,
              amount: refund.amount,
              status: refund.status,
              completedAt: refund.completedAt?.toISOString() ?? null,
              failedAt: refund.failedAt?.toISOString() ?? null,
            })),
          }
        : null,
    };
  }

  async getMyBookings(user: AuthenticatedUser): Promise<GetMyBookingResponseDto[]> {
    const bookings = await this.bookingRepository.findBookingsByUserId(user.id);

    return bookings.map((booking) => ({
      id: booking.id,
      status: booking.status,
      confirmedAt: booking.confirmedAt?.toISOString() ?? null,
      ...this.toBookingRelations(booking),
    }));
  }

  private toBookingRelations(booking: SelectedBookingRelations) {
    return {
      movie: {
        id: booking.screening.movie.id,
        title: booking.screening.movie.title,
      },
      screening: {
        id: booking.screening.id,
        startAt: booking.screening.startAt.toISOString(),
      },
      screen: {
        id: booking.screening.screen.id,
        number: booking.screening.screen.number,
        floor: booking.screening.screen.floor,
        screenType: booking.screening.screen.screenType,
      },
      seats: booking.bookingSeats.map((bookingSeat) => ({
        id: bookingSeat.screeningSeat.id,
        row: bookingSeat.screeningSeat.seat.row,
        number: bookingSeat.screeningSeat.seat.number,
      })),
    };
  }
}
