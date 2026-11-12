/**
 * Test Intent:
 * 지정한 Booking, 주문번호, 금액으로 PENDING Payment가 생성됨을 보장한다.
 */

import { jest } from "@jest/globals";
import { Prisma } from "@movie-booking/database-prisma";
import { PAYMENT_PENDING_STATUS } from "../payment.constants.js";
import { PaymentRepository } from "./payment.repository.js";

const BOOKING_ID = "550e8400-e29b-41d4-a716-446655440020";
const PAYMENT_ID = "550e8400-e29b-41d4-a716-446655440030";
const ORDER_ID = "ord_550e8400-e29b-41d4-a716-446655440031";
const AMOUNT = 30_000;

describe("PaymentRepository.createPendingPayment", () => {
  it("creates a pending payment from bookingId, orderId, and amount", async () => {
    const paymentCreate = jest.fn<
      (args: {
        data: {
          bookingId: string;
          orderId: string;
          status: string;
          amount: number;
        };
      }) => Promise<{
        id: string;
        orderId: string;
        amount: number;
        status: string;
      }>
    >();
    paymentCreate.mockResolvedValue({
      id: PAYMENT_ID,
      orderId: ORDER_ID,
      amount: AMOUNT,
      status: PAYMENT_PENDING_STATUS,
    });
    const tx = {
      payment: { create: paymentCreate },
    } as unknown as Prisma.TransactionClient;
    const repository = new PaymentRepository({} as never);

    await repository.createPendingPayment(tx, BOOKING_ID, AMOUNT, ORDER_ID);

    expect(paymentCreate).toHaveBeenCalledWith({
      data: {
        bookingId: BOOKING_ID,
        orderId: ORDER_ID,
        status: PAYMENT_PENDING_STATUS,
        amount: AMOUNT,
      },
      select: {
        id: true,
        orderId: true,
        amount: true,
        status: true,
      },
    });
  });
});
