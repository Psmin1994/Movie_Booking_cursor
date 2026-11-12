/**
 * Test Intent:
 * PAID Payment가 있는 본인 CONFIRMED Booking만 취소됨을 보장한다. PENDING, FAILED, EXPIRED, 이미 취소, 미결제, 결제 없음, 타인 소유는 취소되지 않는다.
 */

import { jest } from "@jest/globals";
import { Prisma } from "@movie-booking/database-prisma";
import {
  PAYMENT_FAILED_STATUS,
  PAYMENT_PAID_STATUS,
} from "../../payment/payment.constants.js";
import {
  BOOKING_CANCELLED_STATUS,
  BOOKING_CONFIRMED_STATUS,
  BOOKING_EXPIRED_STATUS,
  BOOKING_FAILED_STATUS,
  BOOKING_PENDING_STATUS,
  CANCEL_CONFIRMED_BOOKING_RESULT,
} from "../booking.constants.js";
import { BookingRepository } from "./booking.repository.js";

const USER_ID = "550e8400-e29b-41d4-a716-446655440000";
const BOOKING_ID = "550e8400-e29b-41d4-a716-446655440020";
const PAYMENT_ID = "550e8400-e29b-41d4-a716-446655440030";
const AMOUNT = 20_000;

type UpdateMany = (args: {
  where: { status?: string; payment?: { status: string } };
  data: { status: string; cancelledAt?: Date };
}) => Promise<{ count: number }>;

type FindBooking = () => Promise<{
  status: string;
  payment: { status: string } | null;
} | null>;

type FindPayment = () => Promise<{
  id: string;
  amount: number;
  status: string;
} | null>;

describe("BookingRepository.cancelConfirmedBooking", () => {
  let repository: BookingRepository;
  let bookingUpdateMany: jest.MockedFunction<UpdateMany>;
  let bookingFindFirst: jest.MockedFunction<FindBooking>;
  let paymentFindUnique: jest.MockedFunction<FindPayment>;
  let tx: Prisma.TransactionClient;

  beforeEach(() => {
    bookingUpdateMany = jest.fn<UpdateMany>();
    bookingFindFirst = jest.fn<FindBooking>();
    paymentFindUnique = jest.fn<FindPayment>();
    tx = {
      booking: {
        updateMany: bookingUpdateMany,
        findFirst: bookingFindFirst,
      },
      payment: {
        findUnique: paymentFindUnique,
      },
    } as unknown as Prisma.TransactionClient;
    repository = new BookingRepository({} as never);
  });

  it("cancels a confirmed booking that has a paid payment", async () => {
    bookingUpdateMany.mockResolvedValue({ count: 1 });
    paymentFindUnique.mockResolvedValue({
      id: PAYMENT_ID,
      amount: AMOUNT,
      status: PAYMENT_PAID_STATUS,
    });

    const result = await repository.cancelConfirmedBooking(
      tx,
      BOOKING_ID,
      USER_ID,
    );

    expect(bookingUpdateMany).toHaveBeenCalledWith({
      where: {
        id: BOOKING_ID,
        userId: USER_ID,
        status: BOOKING_CONFIRMED_STATUS,
        payment: { status: PAYMENT_PAID_STATUS },
      },
      data: {
        status: BOOKING_CANCELLED_STATUS,
        cancelledAt: expect.any(Date),
      },
    });
    expect(result).toEqual({
      result: CANCEL_CONFIRMED_BOOKING_RESULT.CANCELLED,
      paymentId: PAYMENT_ID,
      amount: AMOUNT,
    });
  });

  it.each([
    BOOKING_PENDING_STATUS,
    BOOKING_FAILED_STATUS,
    BOOKING_EXPIRED_STATUS,
  ])(
    "does not cancel a %s booking",
    async (status) => {
      bookingUpdateMany.mockResolvedValue({ count: 0 });
      bookingFindFirst.mockResolvedValue({ status, payment: null });

      const result = await repository.cancelConfirmedBooking(
        tx,
        BOOKING_ID,
        USER_ID,
      );

      expect(result).toEqual({
        result: CANCEL_CONFIRMED_BOOKING_RESULT.NOT_CANCELLABLE,
      });
    },
  );

  it("does not cancel an already cancelled booking", async () => {
    bookingUpdateMany.mockResolvedValue({ count: 0 });
    bookingFindFirst.mockResolvedValue({
      status: BOOKING_CANCELLED_STATUS,
      payment: { status: PAYMENT_PAID_STATUS },
    });

    const result = await repository.cancelConfirmedBooking(
      tx,
      BOOKING_ID,
      USER_ID,
    );

    expect(result).toEqual({
      result: CANCEL_CONFIRMED_BOOKING_RESULT.ALREADY_CANCELLED,
    });
  });

  it("does not cancel a confirmed booking whose payment is not paid", async () => {
    bookingUpdateMany.mockResolvedValue({ count: 0 });
    bookingFindFirst.mockResolvedValue({
      status: BOOKING_CONFIRMED_STATUS,
      payment: { status: PAYMENT_FAILED_STATUS },
    });

    const result = await repository.cancelConfirmedBooking(
      tx,
      BOOKING_ID,
      USER_ID,
    );

    expect(result).toEqual({
      result: CANCEL_CONFIRMED_BOOKING_RESULT.PAYMENT_NOT_PAID,
    });
  });

  it("does not cancel a confirmed booking that has no payment", async () => {
    bookingUpdateMany.mockResolvedValue({ count: 0 });
    bookingFindFirst.mockResolvedValue({
      status: BOOKING_CONFIRMED_STATUS,
      payment: null,
    });

    const result = await repository.cancelConfirmedBooking(
      tx,
      BOOKING_ID,
      USER_ID,
    );

    expect(result).toEqual({
      result: CANCEL_CONFIRMED_BOOKING_RESULT.PAYMENT_NOT_PAID,
    });
  });

  it("returns not found when the booking is missing or belongs to another user", async () => {
    bookingUpdateMany.mockResolvedValue({ count: 0 });
    bookingFindFirst.mockResolvedValue(null);

    const result = await repository.cancelConfirmedBooking(
      tx,
      BOOKING_ID,
      USER_ID,
    );

    expect(result).toEqual({
      result: CANCEL_CONFIRMED_BOOKING_RESULT.NOT_FOUND,
    });
  });
});
