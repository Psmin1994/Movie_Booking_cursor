/**
 * Test Intent:
 * 결제 전 취소에서 보유 시각이 남은 본인 PENDING Booking의 PENDING Payment만 CANCELED가 됨을 보장한다. Booking 행은 이 변경에서 바뀌지 않는다.
 */

import { jest } from "@jest/globals";
import { Prisma } from "@movie-booking/database-prisma";
import { BOOKING_PENDING_STATUS } from "../../booking/booking.constants.js";
import { PAYMENT_CANCELED_STATUS, PAYMENT_PENDING_STATUS } from "../payment.constants.js";
import { cancelPendingPayment } from "./payment.repository.js";

const USER_ID = "550e8400-e29b-41d4-a716-446655440000";
const BOOKING_ID = "550e8400-e29b-41d4-a716-446655440020";
const PAYMENT_ID = "550e8400-e29b-41d4-a716-446655440030";
const NOW = new Date("2026-10-14T00:00:00.000Z");

type UpdateMany = (args: {
  where: {
    id?: string;
    status?: string;
    booking?: { id: string; userId: string; status: string; expiresAt: { gt: Date } };
  };
  data: { status: string };
}) => Promise<{ count: number }>;

describe("cancelPendingPayment", () => {
  it("cancels only a pending payment on an open owned pending booking", async () => {
    const paymentUpdateMany = jest.fn<UpdateMany>();
    const bookingUpdateMany = jest.fn<UpdateMany>();
    paymentUpdateMany.mockResolvedValue({ count: 1 });
    const tx = {
      payment: { updateMany: paymentUpdateMany },
      booking: { updateMany: bookingUpdateMany },
    } as unknown as Prisma.TransactionClient;

    await expect(cancelPendingPayment(tx, PAYMENT_ID, BOOKING_ID, USER_ID, NOW)).resolves.toEqual({
      count: 1,
    });
    expect(paymentUpdateMany).toHaveBeenCalledWith({
      where: {
        id: PAYMENT_ID,
        status: PAYMENT_PENDING_STATUS,
        booking: {
          id: BOOKING_ID,
          userId: USER_ID,
          status: BOOKING_PENDING_STATUS,
          expiresAt: { gt: NOW },
        },
      },
      data: {
        status: PAYMENT_CANCELED_STATUS,
      },
    });
    expect(bookingUpdateMany).not.toHaveBeenCalled();
  });
});
