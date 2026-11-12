/**
 * Test Intent:
 * 본인 PENDING Booking의 AUTHORIZING Payment만, 승인 기한이 도달했거나 지났을 때 RECONCILIATION_REQUIRED가 됨을 보장한다. 금액, paymentKey, Booking은 이 갱신에서 바뀌지 않고, 다른 상태나 타인 결제, 기한 전 결제는 전이되지 않는다.
 */

import { jest } from "@jest/globals";
import { Prisma } from "@movie-booking/database-prisma";
import { BOOKING_PENDING_STATUS } from "../../booking/booking.constants.js";
import {
  PAYMENT_AUTHORIZING_STATUS,
  PAYMENT_RECONCILIATION_REQUIRED_STATUS,
  RECONCILE_AUTHORIZING_PAYMENT_RESULT,
} from "../payment.constants.js";
import { PaymentRepository } from "./payment.repository.js";

const USER_ID = "550e8400-e29b-41d4-a716-446655440000";
const OTHER_USER_ID = "550e8400-e29b-41d4-a716-446655440099";
const PAYMENT_ID = "550e8400-e29b-41d4-a716-446655440030";
const NOW = new Date("2026-10-04T12:00:00.000Z");

type UpdateMany = (args: {
  where: { status?: string; booking?: { userId: string; status?: string } };
  data: {
    status: string;
    amount?: number;
    paymentKey?: string;
    failedAt?: Date;
    paidAt?: Date;
  };
}) => Promise<{ count: number }>;

type FindPayment = () => Promise<{ id: string } | null>;

describe("PaymentRepository.reconcileAuthorizingPayment", () => {
  let repository: PaymentRepository;
  let paymentUpdateMany: jest.MockedFunction<UpdateMany>;
  let paymentFindFirst: jest.MockedFunction<FindPayment>;
  let bookingUpdateMany: jest.MockedFunction<UpdateMany>;
  let tx: Prisma.TransactionClient;

  beforeEach(() => {
    paymentUpdateMany = jest.fn<UpdateMany>();
    paymentFindFirst = jest.fn<FindPayment>();
    bookingUpdateMany = jest.fn<UpdateMany>();
    tx = {
      payment: {
        updateMany: paymentUpdateMany,
        findFirst: paymentFindFirst,
      },
      booking: {
        updateMany: bookingUpdateMany,
      },
    } as unknown as Prisma.TransactionClient;
    repository = new PaymentRepository({} as never);
  });

  it("requires reconciliation only for an authorizing payment on a pending booking", async () => {
    paymentUpdateMany.mockResolvedValue({ count: 1 });

    const result = await repository.reconcileAuthorizingPayment(tx, PAYMENT_ID, USER_ID, NOW);

    expect(result).toEqual({
      result: RECONCILE_AUTHORIZING_PAYMENT_RESULT.RECONCILIATION_REQUIRED,
    });
    expect(paymentUpdateMany).toHaveBeenCalledWith({
      where: {
        id: PAYMENT_ID,
        status: PAYMENT_AUTHORIZING_STATUS,
        authorizationExpiresAt: { lte: NOW },
        booking: {
          userId: USER_ID,
          status: BOOKING_PENDING_STATUS,
        },
      },
      data: {
        status: PAYMENT_RECONCILIATION_REQUIRED_STATUS,
      },
    });
    expect(paymentUpdateMany.mock.calls[0]?.[0].data).not.toHaveProperty("amount");
    expect(paymentUpdateMany.mock.calls[0]?.[0].data).not.toHaveProperty("paymentKey");
    expect(paymentUpdateMany.mock.calls[0]?.[0].data).not.toHaveProperty("failedAt");
    expect(paymentUpdateMany.mock.calls[0]?.[0].data).not.toHaveProperty("paidAt");
    expect(bookingUpdateMany).not.toHaveBeenCalled();
    expect(paymentFindFirst).not.toHaveBeenCalled();
  });

  it.each(["PENDING", "PAID", "FAILED", "EXPIRED", "RECONCILIATION_REQUIRED"])(
    "does not reconcile a %s payment",
    async () => {
      paymentUpdateMany.mockResolvedValue({ count: 0 });
      paymentFindFirst.mockResolvedValue({ id: PAYMENT_ID });

      const result = await repository.reconcileAuthorizingPayment(tx, PAYMENT_ID, USER_ID, NOW);

      expect(result).toEqual({
        result: RECONCILE_AUTHORIZING_PAYMENT_RESULT.NOT_AUTHORIZING,
      });
      expect(bookingUpdateMany).not.toHaveBeenCalled();
      expect(paymentUpdateMany.mock.calls[0]?.[0].where.status).toBe(
        PAYMENT_AUTHORIZING_STATUS,
      );
    },
  );

  it("does not reconcile another user's payment", async () => {
    paymentUpdateMany.mockResolvedValue({ count: 0 });
    paymentFindFirst.mockResolvedValue(null);

    const result = await repository.reconcileAuthorizingPayment(
      tx,
      PAYMENT_ID,
      OTHER_USER_ID,
      NOW,
    );

    expect(result).toEqual({ result: RECONCILE_AUTHORIZING_PAYMENT_RESULT.NOT_FOUND });
    expect(paymentUpdateMany.mock.calls[0]?.[0].where.booking?.userId).toBe(OTHER_USER_ID);
    expect(bookingUpdateMany).not.toHaveBeenCalled();
  });
});
