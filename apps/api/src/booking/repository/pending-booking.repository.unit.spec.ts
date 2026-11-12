/**
 * Test Intent:
 * 소유자의 PENDING Booking만 CONFIRMED 또는 FAILED로 전이됨을 보장한다. 이 전이에서 Payment는 바뀌지 않는다.
 */

import { jest } from "@jest/globals";
import { Prisma } from "@movie-booking/database-prisma";
import {
  BOOKING_CONFIRMED_STATUS,
  BOOKING_FAILED_STATUS,
  BOOKING_PENDING_STATUS,
} from "../booking.constants.js";
import { BookingRepository } from "./booking.repository.js";

const USER_ID = "550e8400-e29b-41d4-a716-446655440000";
const BOOKING_ID = "550e8400-e29b-41d4-a716-446655440020";
const CONFIRMED_AT = new Date("2026-09-24T10:30:00.000Z");
const FAILED_AT = new Date("2026-09-24T10:31:00.000Z");

describe("BookingRepository pending booking transitions", () => {
  const repository = new BookingRepository({} as never);

  it("confirms only an owned pending booking", async () => {
    const updateMany = jest.fn<(args: unknown) => Promise<{ count: number }>>();
    updateMany.mockResolvedValue({ count: 1 });
    const paymentUpdateMany = jest.fn<(args: unknown) => Promise<{ count: number }>>();
    const tx = {
      booking: { updateMany },
      payment: { updateMany: paymentUpdateMany },
    } as unknown as Prisma.TransactionClient;

    await expect(
      repository.confirmPendingBooking(tx, BOOKING_ID, USER_ID, CONFIRMED_AT),
    ).resolves.toEqual({ count: 1 });

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: BOOKING_ID,
        userId: USER_ID,
        status: BOOKING_PENDING_STATUS,
      },
      data: {
        status: BOOKING_CONFIRMED_STATUS,
        confirmedAt: CONFIRMED_AT,
      },
    });
    expect(paymentUpdateMany).not.toHaveBeenCalled();
  });

  it("fails only an owned pending booking", async () => {
    const updateMany = jest.fn<(args: unknown) => Promise<{ count: number }>>();
    updateMany.mockResolvedValue({ count: 1 });
    const paymentUpdateMany = jest.fn<(args: unknown) => Promise<{ count: number }>>();
    const tx = {
      booking: { updateMany },
      payment: { updateMany: paymentUpdateMany },
    } as unknown as Prisma.TransactionClient;

    await expect(repository.failPendingBooking(tx, BOOKING_ID, USER_ID, FAILED_AT)).resolves.toEqual({
      count: 1,
    });

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: BOOKING_ID,
        userId: USER_ID,
        status: BOOKING_PENDING_STATUS,
      },
      data: {
        status: BOOKING_FAILED_STATUS,
        failedAt: FAILED_AT,
      },
    });
    expect(paymentUpdateMany).not.toHaveBeenCalled();
  });
});
