/**
 * Test Intent:
 * 보유 시각이 지난 PENDING Booking의 PENDING Payment만 EXPIRED가 됨을 보장한다. 사용자 경로의 만료와 기한 경과 만료를 구분하고, Booking은 이 변경에서 바뀌지 않는다. 만료 후보도 같은 조건의 Payment만 고른다.
 */

import { jest } from "@jest/globals";
import { Prisma } from "@movie-booking/database-prisma";
import { BOOKING_PENDING_STATUS } from "../../booking/booking.constants.js";
import {
  EXPIRE_PAYMENT_RESULT,
  PAYMENT_EXPIRED_STATUS,
  PAYMENT_PENDING_STATUS,
} from "../payment.constants.js";
import { PaymentRepository } from "./payment.repository.js";

const USER_ID = "550e8400-e29b-41d4-a716-446655440000";
const PAYMENT_ID = "550e8400-e29b-41d4-a716-446655440030";
const BOOKING_ID = "550e8400-e29b-41d4-a716-446655440020";
const NOW = new Date("2026-10-04T12:00:00.000Z");

type UpdateMany = (args: {
  where: { status?: string };
  data: { status: string; authorizationExpiresAt?: Date };
}) => Promise<{ count: number }>;

type FindPayment = () => Promise<{
  id: string;
  bookingId?: string;
  status?: string;
} | null>;

describe("PaymentRepository.expirePendingPayment", () => {
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

  it("expires a pending payment after the hold ends without changing the booking", async () => {
    paymentUpdateMany.mockResolvedValue({ count: 1 });
    paymentFindUniqueOrThrow.mockResolvedValue({
      id: PAYMENT_ID,
      bookingId: BOOKING_ID,
      status: PAYMENT_EXPIRED_STATUS,
    });

    const result = await repository.expirePendingPayment(tx, PAYMENT_ID, USER_ID, NOW);

    expect(paymentUpdateMany).toHaveBeenCalledWith({
      where: {
        id: PAYMENT_ID,
        status: PAYMENT_PENDING_STATUS,
        booking: {
          userId: USER_ID,
          status: BOOKING_PENDING_STATUS,
          expiresAt: { lte: NOW },
        },
      },
      data: {
        status: PAYMENT_EXPIRED_STATUS,
      },
    });
    expect(bookingUpdateMany).not.toHaveBeenCalled();
    expect(result).toEqual({
      result: EXPIRE_PAYMENT_RESULT.EXPIRED,
      payment: {
        id: PAYMENT_ID,
        bookingId: BOOKING_ID,
        status: PAYMENT_EXPIRED_STATUS,
      },
    });
  });

  it("does not expire a payment that is no longer pending", async () => {
    paymentUpdateMany.mockResolvedValue({ count: 0 });
    paymentFindFirst.mockResolvedValue({ id: PAYMENT_ID });

    const result = await repository.expirePendingPayment(tx, PAYMENT_ID, USER_ID, NOW);

    expect(result).toEqual({ result: EXPIRE_PAYMENT_RESULT.NOT_EXPIRED });
    expect(bookingUpdateMany).not.toHaveBeenCalled();
    expect(paymentUpdateMany.mock.calls[0]?.[0].where.status).toBe(PAYMENT_PENDING_STATUS);
  });

  it("reports a missing payment when the owner cannot see it", async () => {
    paymentUpdateMany.mockResolvedValue({ count: 0 });
    paymentFindFirst.mockResolvedValue(null);

    const result = await repository.expirePendingPayment(tx, PAYMENT_ID, USER_ID, NOW);

    expect(result).toEqual({ result: EXPIRE_PAYMENT_RESULT.NOT_FOUND });
    expect(bookingUpdateMany).not.toHaveBeenCalled();
  });
});

describe("PaymentRepository.expirePendingPaymentPastExpiry", () => {
  let repository: PaymentRepository;
  let paymentUpdateMany: jest.MockedFunction<UpdateMany>;
  let paymentFindUniqueOrThrow: jest.MockedFunction<FindPayment>;
  let bookingUpdateMany: jest.MockedFunction<UpdateMany>;
  let tx: Prisma.TransactionClient;

  beforeEach(() => {
    paymentUpdateMany = jest.fn<UpdateMany>();
    paymentFindUniqueOrThrow = jest.fn<FindPayment>();
    bookingUpdateMany = jest.fn<UpdateMany>();
    tx = {
      payment: {
        updateMany: paymentUpdateMany,
        findUniqueOrThrow: paymentFindUniqueOrThrow,
      },
      booking: {
        updateMany: bookingUpdateMany,
      },
    } as unknown as Prisma.TransactionClient;
    repository = new PaymentRepository({} as never);
  });

  it("expires only a pending payment whose booking is still pending and has reached expiresAt", async () => {
    paymentUpdateMany.mockResolvedValue({ count: 1 });
    paymentFindUniqueOrThrow.mockResolvedValue({
      id: PAYMENT_ID,
      bookingId: BOOKING_ID,
    });

    await expect(repository.expirePendingPaymentPastExpiry(tx, PAYMENT_ID, NOW)).resolves.toEqual({
      count: 1,
      bookingId: BOOKING_ID,
    });

    expect(paymentUpdateMany).toHaveBeenCalledWith({
      where: {
        id: PAYMENT_ID,
        status: PAYMENT_PENDING_STATUS,
        booking: {
          status: BOOKING_PENDING_STATUS,
          expiresAt: { lte: NOW },
        },
      },
      data: {
        status: PAYMENT_EXPIRED_STATUS,
      },
    });
    expect(paymentUpdateMany.mock.calls[0]?.[0].where).not.toHaveProperty("booking.userId");
    expect(JSON.stringify(paymentUpdateMany.mock.calls[0]?.[0].where)).not.toContain("userId");
  });

  it("does not load the payment when it is not eligible", async () => {
    paymentUpdateMany.mockResolvedValue({ count: 0 });

    await expect(repository.expirePendingPaymentPastExpiry(tx, PAYMENT_ID, NOW)).resolves.toEqual({
      count: 0,
      bookingId: null,
    });

    expect(paymentFindUniqueOrThrow).not.toHaveBeenCalled();
    expect(bookingUpdateMany).not.toHaveBeenCalled();
  });
});

describe("PaymentRepository.findExpiredPendingPaymentIds", () => {
  it("finds pending payment ids whose booking is still pending and has reached expiresAt", async () => {
    const limit = 25;
    const findMany = jest.fn<(args: unknown) => Promise<{ id: string }[]>>();
    findMany.mockResolvedValue([{ id: PAYMENT_ID }]);
    const repositoryWithClient = new PaymentRepository({
      client: { payment: { findMany } },
    } as never);

    await expect(repositoryWithClient.findExpiredPendingPaymentIds(NOW, limit)).resolves.toEqual([
      PAYMENT_ID,
    ]);

    expect(findMany).toHaveBeenCalledWith({
      where: {
        status: PAYMENT_PENDING_STATUS,
        booking: {
          status: BOOKING_PENDING_STATUS,
          expiresAt: { lte: NOW },
        },
      },
      orderBy: { booking: { expiresAt: "asc" } },
      take: limit,
      select: { id: true },
    });
  });
});
