/**
 * Test Intent:
 * 기한이 지난 AUTHORIZING Payment만 RECONCILIATION_REQUIRED가 됨을 보장한다. Booking이 PENDING이 아니거나 기한이 남아 있으면 갱신하지 않고, 실패하면 Booking 식별자를 반환하지 않는다. Booking 행은 이 갱신에서 바뀌지 않는다.
 */

import { jest } from "@jest/globals";
import { Prisma } from "@movie-booking/database-prisma";
import { BOOKING_PENDING_STATUS } from "../../booking/booking.constants.js";
import {
  PAYMENT_AUTHORIZING_STATUS,
  PAYMENT_RECONCILIATION_REQUIRED_STATUS,
} from "../payment.constants.js";
import { PaymentRepository } from "./payment.repository.js";

const USER_ID = "550e8400-e29b-41d4-a716-446655440000";
const PAYMENT_ID = "550e8400-e29b-41d4-a716-446655440030";
const BOOKING_ID = "550e8400-e29b-41d4-a716-446655440020";
const NOW = new Date("2026-10-04T12:00:00.000Z");

type UpdateMany = (args: {
  where: {
    status?: string;
    authorizationExpiresAt?: { lte?: Date };
    booking?: { status?: string };
  };
  data: { status: string; failedAt?: Date; paidAt?: Date; amount?: number };
}) => Promise<{ count: number }>;

type FindPayment = () => Promise<{
  bookingId: string;
  booking: { userId: string };
} | null>;

describe("PaymentRepository.recoverAuthorizingPaymentPastDeadline", () => {
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

  it("requires reconciliation only after the authorization deadline for a pending booking", async () => {
    paymentUpdateMany.mockResolvedValue({ count: 1 });
    paymentFindUniqueOrThrow.mockResolvedValue({
      bookingId: BOOKING_ID,
      booking: { userId: USER_ID },
    });

    await expect(
      repository.recoverAuthorizingPaymentPastDeadline(tx, PAYMENT_ID, NOW),
    ).resolves.toEqual({
      count: 1,
      bookingId: BOOKING_ID,
      userId: USER_ID,
    });

    expect(paymentUpdateMany).toHaveBeenCalledWith({
      where: {
        id: PAYMENT_ID,
        status: PAYMENT_AUTHORIZING_STATUS,
        authorizationExpiresAt: { lte: NOW },
        booking: { status: BOOKING_PENDING_STATUS },
      },
      data: {
        status: PAYMENT_RECONCILIATION_REQUIRED_STATUS,
      },
    });
    expect(paymentUpdateMany.mock.calls[0]?.[0].data).not.toHaveProperty("failedAt");
    expect(paymentUpdateMany.mock.calls[0]?.[0].data).not.toHaveProperty("paidAt");
    expect(paymentUpdateMany.mock.calls[0]?.[0].data).not.toHaveProperty("amount");
    expect(bookingUpdateMany).not.toHaveBeenCalled();
  });

  it("does not return booking identity when the payment is no longer eligible", async () => {
    paymentUpdateMany.mockResolvedValue({ count: 0 });

    await expect(
      repository.recoverAuthorizingPaymentPastDeadline(tx, PAYMENT_ID, NOW),
    ).resolves.toEqual({
      count: 0,
      bookingId: null,
      userId: null,
    });

    expect(paymentUpdateMany.mock.calls[0]?.[0].where.status).toBe(PAYMENT_AUTHORIZING_STATUS);
    expect(paymentUpdateMany.mock.calls[0]?.[0].where.authorizationExpiresAt).toEqual({
      lte: NOW,
    });
    expect(paymentFindUniqueOrThrow).not.toHaveBeenCalled();
    expect(bookingUpdateMany).not.toHaveBeenCalled();
  });
});

describe("PaymentRepository.findAuthorizingPaymentIdsPastDeadline", () => {
  it("finds authorizing payment ids whose deadline has passed and whose booking is pending", async () => {
    const limit = 25;
    const findMany = jest.fn<(args: unknown) => Promise<{ id: string }[]>>();
    findMany.mockResolvedValue([{ id: PAYMENT_ID }]);
    const repositoryWithClient = new PaymentRepository({
      client: { payment: { findMany } },
    } as never);

    await expect(
      repositoryWithClient.findAuthorizingPaymentIdsPastDeadline(NOW, limit),
    ).resolves.toEqual([PAYMENT_ID]);

    expect(findMany).toHaveBeenCalledWith({
      where: {
        status: PAYMENT_AUTHORIZING_STATUS,
        authorizationExpiresAt: { lte: NOW },
        booking: { status: BOOKING_PENDING_STATUS },
      },
      orderBy: { authorizationExpiresAt: "asc" },
      take: limit,
      select: { id: true },
    });
  });
});
