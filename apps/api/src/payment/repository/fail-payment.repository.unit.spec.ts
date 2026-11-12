/**
 * Test Intent:
 * 본인 PENDING Booking의 AUTHORIZING Payment만 FAILED가 됨을 보장한다. 금액과 Booking은 바뀌지 않고, 다른 상태나 타인 결제는 실패로 바뀌지 않는다.
 */

import { jest } from "@jest/globals";
import { Prisma } from "@movie-booking/database-prisma";
import { BOOKING_PENDING_STATUS } from "../../booking/booking.constants.js";
import {
  FAIL_PAYMENT_RESULT,
  PAYMENT_AUTHORIZING_STATUS,
  PAYMENT_FAILED_STATUS,
} from "../payment.constants.js";
import { PaymentRepository } from "./payment.repository.js";

const USER_ID = "550e8400-e29b-41d4-a716-446655440000";
const OTHER_USER_ID = "550e8400-e29b-41d4-a716-446655440099";
const PAYMENT_ID = "550e8400-e29b-41d4-a716-446655440030";
const BOOKING_ID = "550e8400-e29b-41d4-a716-446655440020";
const AMOUNT = 10_000;

type UpdateMany = (args: {
  where: { status?: string; booking?: { userId: string } };
  data: {
    status: string;
    failedAt?: Date;
    amount?: number;
  };
}) => Promise<{ count: number }>;

type FindPayment = () => Promise<{
  id: string;
  bookingId?: string;
  status?: string;
  amount?: number;
  failedAt?: Date;
} | null>;

describe("PaymentRepository authorizing payment failure", () => {
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

  it("fails an authorizing payment without changing amount or the booking", async () => {
      paymentUpdateMany.mockResolvedValue({ count: 1 });
      paymentFindUniqueOrThrow.mockResolvedValue({
        id: PAYMENT_ID,
        bookingId: BOOKING_ID,
        status: PAYMENT_FAILED_STATUS,
        amount: AMOUNT,
        failedAt: new Date("2026-09-24T10:30:00.000Z"),
      });

      const result = await repository.failAuthorizingPayment(
        tx,
        PAYMENT_ID,
        USER_ID,
      );

      expect(paymentUpdateMany).toHaveBeenCalledWith({
        where: {
          id: PAYMENT_ID,
          status: PAYMENT_AUTHORIZING_STATUS,
          booking: {
            userId: USER_ID,
            status: BOOKING_PENDING_STATUS,
          },
        },
        data: {
          status: PAYMENT_FAILED_STATUS,
          failedAt: expect.any(Date),
        },
      });
      expect(paymentUpdateMany.mock.calls[0]?.[0].data).not.toHaveProperty(
        "amount",
      );
      expect(bookingUpdateMany).not.toHaveBeenCalled();
      expect(result).toEqual({
        result: FAIL_PAYMENT_RESULT.FAILED,
        payment: {
          id: PAYMENT_ID,
          bookingId: BOOKING_ID,
          status: PAYMENT_FAILED_STATUS,
          failedAt: new Date("2026-09-24T10:30:00.000Z"),
        },
      });
    },
  );

  it.each(["PENDING", "PAID", "FAILED", "EXPIRED"])(
    "does not fail a %s payment",
    async () => {
      paymentUpdateMany.mockResolvedValue({ count: 0 });
      paymentFindFirst.mockResolvedValue({ id: PAYMENT_ID });

      const result = await repository.failAuthorizingPayment(
        tx,
        PAYMENT_ID,
        USER_ID,
      );

      expect(result).toEqual({ result: FAIL_PAYMENT_RESULT.NOT_AUTHORIZING });
      expect(bookingUpdateMany).not.toHaveBeenCalled();
      expect(paymentUpdateMany.mock.calls[0]?.[0].where.status).toBe(
        PAYMENT_AUTHORIZING_STATUS,
      );
    },
  );

  it("does not fail another user's payment", async () => {
    paymentUpdateMany.mockResolvedValue({ count: 0 });
    paymentFindFirst.mockResolvedValue(null);

    const result = await repository.failAuthorizingPayment(
      tx,
      PAYMENT_ID,
      OTHER_USER_ID,
    );

    expect(result).toEqual({ result: FAIL_PAYMENT_RESULT.NOT_FOUND });
    expect(paymentUpdateMany.mock.calls[0]?.[0].where.booking?.userId).toBe(
      OTHER_USER_ID,
    );
    expect(bookingUpdateMany).not.toHaveBeenCalled();
  });
});
