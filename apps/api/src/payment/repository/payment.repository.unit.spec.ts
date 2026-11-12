/**
 * Test Intent:
 * 본인 PENDING Booking의 AUTHORIZING Payment만, 승인 기한 전일 때 PAID가 됨을 보장한다. 금액과 Booking은 바뀌지 않고, 다른 상태나 기한이 지난 결제는 결제 완료로 바뀌지 않는다.
 */

import { jest } from "@jest/globals";
import { Prisma } from "@movie-booking/database-prisma";
import { BOOKING_PENDING_STATUS } from "../../booking/booking.constants.js";
import {
  PAY_PAYMENT_RESULT,
  PAYMENT_AUTHORIZING_STATUS,
  PAYMENT_PAID_STATUS,
} from "../payment.constants.js";
import { PaymentRepository } from "./payment.repository.js";

const USER_ID = "550e8400-e29b-41d4-a716-446655440000";
const PAYMENT_ID = "550e8400-e29b-41d4-a716-446655440030";
const BOOKING_ID = "550e8400-e29b-41d4-a716-446655440020";
const AMOUNT = 20_000;
const NOW = new Date("2026-10-04T12:00:00.000Z");

type UpdateMany = (args: {
  where: { status?: string };
  data: {
    status: string;
    paidAt?: Date;
    confirmedAt?: Date;
    amount?: number;
  };
}) => Promise<{ count: number }>;

type FindPayment = () => Promise<{
  id: string;
  bookingId?: string;
  status?: string;
  amount?: number;
  paidAt?: Date;
} | null>;

describe("PaymentRepository.payAuthorizingPayment", () => {
  let repository: PaymentRepository;
  let paymentUpdateMany: jest.MockedFunction<UpdateMany>;
  let paymentFindFirst: jest.MockedFunction<FindPayment>;
  let paymentFindUniqueOrThrow: jest.MockedFunction<FindPayment>;
  let bookingUpdateMany: jest.MockedFunction<UpdateMany>;
  let tx: Prisma.TransactionClient;

  beforeEach(() => {
    paymentUpdateMany = jest.fn<UpdateMany>();
    paymentFindFirst = jest.fn<FindPayment>();
    paymentFindUniqueOrThrow = jest.fn<FindPayment>();
    bookingUpdateMany = jest.fn<UpdateMany>();
    tx = {
      payment: {
        updateMany: paymentUpdateMany,
        findFirst: paymentFindFirst,
        findUniqueOrThrow: paymentFindUniqueOrThrow,
      },
      booking: {
        updateMany: bookingUpdateMany,
      },
    } as unknown as Prisma.TransactionClient;
    repository = new PaymentRepository({} as never);
  });

  it("marks an authorizing payment paid without changing amount or the booking", async () => {
    paymentUpdateMany.mockResolvedValue({ count: 1 });
    paymentFindUniqueOrThrow.mockResolvedValue({
      id: PAYMENT_ID,
      bookingId: BOOKING_ID,
      status: PAYMENT_PAID_STATUS,
      amount: AMOUNT,
      paidAt: new Date("2026-09-24T10:30:00.000Z"),
    });

    const result = await repository.payAuthorizingPayment(tx, PAYMENT_ID, USER_ID, "pay-key", NOW);

    expect(paymentUpdateMany).toHaveBeenCalledWith({
      where: {
        id: PAYMENT_ID,
        status: PAYMENT_AUTHORIZING_STATUS,
        authorizationExpiresAt: { gt: NOW },
        booking: {
          userId: USER_ID,
          status: BOOKING_PENDING_STATUS,
        },
      },
      data: {
        status: PAYMENT_PAID_STATUS,
        paymentKey: "pay-key",
        paidAt: NOW,
      },
    });
    expect(paymentUpdateMany.mock.calls[0]?.[0].data).not.toHaveProperty(
      "amount",
    );
    expect(bookingUpdateMany).not.toHaveBeenCalled();
    expect(result).toEqual({
      result: PAY_PAYMENT_RESULT.PAID,
      payment: {
        id: PAYMENT_ID,
        bookingId: BOOKING_ID,
        status: PAYMENT_PAID_STATUS,
        amount: AMOUNT,
        paidAt: new Date("2026-09-24T10:30:00.000Z"),
      },
    });
  });

  it.each(["PENDING", "PAID", "FAILED", "EXPIRED"])(
    "does not update a %s payment",
    async () => {
      paymentUpdateMany.mockResolvedValue({ count: 0 });
      paymentFindFirst.mockResolvedValue({ id: PAYMENT_ID });

      const result = await repository.payAuthorizingPayment(
        tx,
        PAYMENT_ID,
        USER_ID,
        "pay-key",
        NOW,
      );

      expect(result).toEqual({ result: PAY_PAYMENT_RESULT.NOT_AUTHORIZING });
      expect(bookingUpdateMany).not.toHaveBeenCalled();
      expect(paymentUpdateMany.mock.calls[0]?.[0].where.status).toBe(
        PAYMENT_AUTHORIZING_STATUS,
      );
      expect(paymentUpdateMany.mock.calls[0]?.[0].where).not.toHaveProperty(
        "booking.expiresAt",
      );
    },
  );
});
