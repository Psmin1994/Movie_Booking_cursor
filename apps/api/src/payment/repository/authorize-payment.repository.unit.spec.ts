/**
 * Test Intent:
 * 보유 시간이 남은 본인 PENDING Booking의 PENDING Payment만 AUTHORIZING이 됨을 보장한다. 조건이 맞지 않거나 소유하지 않으면 승인 시작으로 바뀌지 않는다.
 */

import { jest } from "@jest/globals";
import { Prisma } from "@movie-booking/database-prisma";
import { BOOKING_PENDING_STATUS } from "../../booking/booking.constants.js";
import {
  BEGIN_AUTHORIZATION_RESULT,
  PAYMENT_AUTHORIZATION_WINDOW_MS,
  PAYMENT_AUTHORIZING_STATUS,
  PAYMENT_PENDING_STATUS,
} from "../payment.constants.js";
import { PaymentRepository } from "./payment.repository.js";

const USER_ID = "550e8400-e29b-41d4-a716-446655440000";
const PAYMENT_ID = "550e8400-e29b-41d4-a716-446655440030";
const PAYMENT_KEY = "pay-key";
const NOW = new Date("2026-10-04T12:00:00.000Z");

type UpdateMany = (args: {
  where: {
    status?: string;
    booking?: { expiresAt?: { gt?: Date } };
  };
  data: {
    status: string;
    authorizationExpiresAt?: Date;
    authorizingAt?: Date;
    paymentKey?: string;
  };
}) => Promise<{ count: number }>;

type FindPayment = () => Promise<{ id: string } | null>;

describe("PaymentRepository.beginAuthorization", () => {
  let repository: PaymentRepository;
  let paymentUpdateMany: jest.MockedFunction<UpdateMany>;
  let paymentFindFirst: jest.MockedFunction<FindPayment>;
  let tx: Prisma.TransactionClient;

  beforeEach(() => {
    paymentUpdateMany = jest.fn<UpdateMany>();
    paymentFindFirst = jest.fn<FindPayment>();
    tx = {
      payment: {
        updateMany: paymentUpdateMany,
        findFirst: paymentFindFirst,
      },
    } as unknown as Prisma.TransactionClient;
    repository = new PaymentRepository({} as never);
  });

  it("authorizes only a pending payment whose booking hold is still open", async () => {
    paymentUpdateMany.mockResolvedValue({ count: 1 });

    const result = await repository.beginAuthorization(tx, PAYMENT_ID, USER_ID, PAYMENT_KEY, NOW);

    expect(result).toEqual({
      result: BEGIN_AUTHORIZATION_RESULT.AUTHORIZING,
      authorizationExpiresAt: new Date(NOW.getTime() + PAYMENT_AUTHORIZATION_WINDOW_MS),
    });
    expect(paymentUpdateMany).toHaveBeenCalledWith({
      where: {
        id: PAYMENT_ID,
        status: PAYMENT_PENDING_STATUS,
        booking: {
          userId: USER_ID,
          status: BOOKING_PENDING_STATUS,
          expiresAt: { gt: NOW },
        },
      },
      data: {
        status: PAYMENT_AUTHORIZING_STATUS,
        authorizationExpiresAt: new Date(NOW.getTime() + PAYMENT_AUTHORIZATION_WINDOW_MS),
        paymentKey: PAYMENT_KEY,
      },
    });
    expect(paymentUpdateMany.mock.calls[0]?.[0].data).not.toHaveProperty("authorizingAt");
    expect(paymentFindFirst).not.toHaveBeenCalled();
  });

  it("does not authorize when the conditional update matches nothing", async () => {
    paymentUpdateMany.mockResolvedValue({ count: 0 });
    paymentFindFirst.mockResolvedValue({ id: PAYMENT_ID });

    const result = await repository.beginAuthorization(tx, PAYMENT_ID, USER_ID, PAYMENT_KEY, NOW);

    expect(result).toEqual({ result: BEGIN_AUTHORIZATION_RESULT.NOT_ELIGIBLE });
  });

  it("reports a missing payment when the owner cannot see it", async () => {
    paymentUpdateMany.mockResolvedValue({ count: 0 });
    paymentFindFirst.mockResolvedValue(null);

    const result = await repository.beginAuthorization(tx, PAYMENT_ID, USER_ID, PAYMENT_KEY, NOW);

    expect(result).toEqual({ result: BEGIN_AUTHORIZATION_RESULT.NOT_FOUND });
  });
});
