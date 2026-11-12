/**
 * Test Intent:
 * 결제 전 취소에 쓰는 Booking 조회와 조건부 CANCELLED 갱신을 보장한다. Payment가 없으면 payment is null, Payment가 CANCELED인 뒤에는 그 상태를 조건으로 한다. Payment 행은 이 메서드가 바꾸지 않는다.
 */

import { jest } from "@jest/globals";
import { Prisma } from "@movie-booking/database-prisma";
import { PAYMENT_CANCELED_STATUS } from "../../payment/payment.constants.js";
import { BOOKING_CANCELLED_STATUS, BOOKING_PENDING_STATUS } from "../booking.constants.js";
import { BookingRepository } from "./booking.repository.js";

const USER_ID = "550e8400-e29b-41d4-a716-446655440000";
const BOOKING_ID = "550e8400-e29b-41d4-a716-446655440020";
const PAYMENT_ID = "550e8400-e29b-41d4-a716-446655440030";
const NOW = new Date("2026-10-14T00:00:00.000Z");
const FUTURE = new Date("2026-10-14T00:10:00.000Z");

type FindBooking = () => Promise<{
  status: string;
  expiresAt: Date;
  payment: { id: string; status: string } | null;
} | null>;

type UpdateMany = (args: {
  where: {
    id?: string;
    userId?: string;
    status?: string;
    expiresAt?: { gt: Date };
    payment?: { status: string } | { is: null };
  };
  data: { status: string; cancelledAt?: Date };
}) => Promise<{ count: number }>;

describe("BookingRepository pending cancel persistence", () => {
  let repository: BookingRepository;
  let bookingFindFirst: jest.MockedFunction<FindBooking>;
  let bookingUpdateMany: jest.MockedFunction<UpdateMany>;
  let paymentUpdateMany: jest.MockedFunction<UpdateMany>;
  let tx: Prisma.TransactionClient;

  beforeEach(() => {
    bookingFindFirst = jest.fn<FindBooking>();
    bookingUpdateMany = jest.fn<UpdateMany>();
    paymentUpdateMany = jest.fn<UpdateMany>();
    tx = {
      booking: {
        findFirst: bookingFindFirst,
        updateMany: bookingUpdateMany,
      },
      payment: {
        updateMany: paymentUpdateMany,
      },
    } as unknown as Prisma.TransactionClient;
    repository = new BookingRepository({} as never);
  });

  it("reads the owned booking with its payment id and status", async () => {
    bookingFindFirst.mockResolvedValue({
      status: BOOKING_PENDING_STATUS,
      expiresAt: FUTURE,
      payment: { id: PAYMENT_ID, status: "PENDING" },
    });

    await expect(repository.findBookingForPendingCancel(tx, BOOKING_ID, USER_ID)).resolves.toEqual({
      status: BOOKING_PENDING_STATUS,
      expiresAt: FUTURE,
      payment: { id: PAYMENT_ID, status: "PENDING" },
    });
    expect(bookingFindFirst).toHaveBeenCalledWith({
      where: { id: BOOKING_ID, userId: USER_ID },
      select: {
        status: true,
        expiresAt: true,
        payment: { select: { id: true, status: true } },
      },
    });
    expect(bookingUpdateMany).not.toHaveBeenCalled();
    expect(paymentUpdateMany).not.toHaveBeenCalled();
  });

  it("cancels a pending booking that has no payment", async () => {
    bookingUpdateMany.mockResolvedValue({ count: 1 });

    await expect(
      repository.cancelPendingBooking(tx, BOOKING_ID, USER_ID, NOW, "none"),
    ).resolves.toEqual({ count: 1 });
    expect(bookingUpdateMany).toHaveBeenCalledWith({
      where: {
        id: BOOKING_ID,
        userId: USER_ID,
        status: BOOKING_PENDING_STATUS,
        expiresAt: { gt: NOW },
        payment: { is: null },
      },
      data: {
        status: BOOKING_CANCELLED_STATUS,
        cancelledAt: NOW,
      },
    });
    expect(paymentUpdateMany).not.toHaveBeenCalled();
  });

  it("cancels a pending booking only after its payment is canceled", async () => {
    bookingUpdateMany.mockResolvedValue({ count: 0 });

    await expect(
      repository.cancelPendingBooking(tx, BOOKING_ID, USER_ID, NOW, "canceled"),
    ).resolves.toEqual({ count: 0 });
    expect(bookingUpdateMany).toHaveBeenCalledWith({
      where: {
        id: BOOKING_ID,
        userId: USER_ID,
        status: BOOKING_PENDING_STATUS,
        expiresAt: { gt: NOW },
        payment: { status: PAYMENT_CANCELED_STATUS },
      },
      data: {
        status: BOOKING_CANCELLED_STATUS,
        cancelledAt: NOW,
      },
    });
    expect(paymentUpdateMany).not.toHaveBeenCalled();
  });
});
