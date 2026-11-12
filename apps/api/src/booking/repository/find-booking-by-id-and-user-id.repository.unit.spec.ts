/**
 * Test Intent:
 * 현재 사용자 소유의 Booking만 결제 가능 여부를 판단할 금액, 상태, 만료 시각, 결제 유무로 조회됨을 보장한다. 소유하지 않으면 대상이 없다.
 */

import { jest } from "@jest/globals";
import { Prisma } from "@movie-booking/database-prisma";
import { BookingRepository } from "./booking.repository.js";

const USER_ID = "550e8400-e29b-41d4-a716-446655440000";
const BOOKING_ID = "550e8400-e29b-41d4-a716-446655440020";

describe("BookingRepository.findBookingByIdAndUserId", () => {
  it("returns null when the booking is not owned by the user", async () => {
    const bookingFindFirst = jest.fn<
      () => Promise<{
        totalAmount: number;
        status: string;
        expiresAt: Date;
        payment: { id: string } | null;
      } | null>
    >();
    bookingFindFirst.mockResolvedValue(null);
    const tx = {
      booking: { findFirst: bookingFindFirst },
    } as unknown as Prisma.TransactionClient;
    const repository = new BookingRepository({} as never);

    const result = await repository.findBookingByIdAndUserId(
      tx,
      BOOKING_ID,
      USER_ID,
    );

    expect(bookingFindFirst).toHaveBeenCalledWith({
      where: {
        id: BOOKING_ID,
        userId: USER_ID,
      },
      select: {
        totalAmount: true,
        status: true,
        expiresAt: true,
        payment: { select: { id: true } },
      },
    });
    expect(result).toBeNull();
  });
});
