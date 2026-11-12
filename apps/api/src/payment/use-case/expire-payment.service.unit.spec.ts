/**
 * Test Intent:
 * 보유 시각이 지난 PENDING Payment와 그 PENDING Booking이 함께 만료되고 점유 좌석이 해제됨을 보장한다. 예매 만료나 좌석 해제가 맞지 않으면 만료는 확정되지 않는다.
 */

import { jest } from "@jest/globals";
import { Prisma } from "@movie-booking/database-prisma";
import { InternalServerErrorException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { BookingRepository } from "../../booking/repository/booking.repository.js";
import { BookingSeatReleaseService } from "../../booking/use-case/booking-seat-release.service.js";
import { PrismaService } from "../../database/prisma.service.js";
import { ScreeningRepository } from "../../screening/repository/screening.repository.js";
import { ExpirePaymentService } from "./expire-payment.service.js";
import { EXPIRE_DUE_PAYMENT_RESULT } from "../payment.constants.js";
import { PaymentRepository } from "../repository/payment.repository.js";

const PAYMENT_ID = "550e8400-e29b-41d4-a716-446655440030";
const BOOKING_ID = "550e8400-e29b-41d4-a716-446655440020";
const SCREENING_SEAT_IDS = [
  "550e8400-e29b-41d4-a716-446655440010",
  "550e8400-e29b-41d4-a716-446655440011",
];
const TX = { name: "transaction-client" } as unknown as Prisma.TransactionClient;
const NOW = new Date("2026-10-04T12:00:00.000Z");

type RunTransaction = (
  callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
) => Promise<unknown>;

describe("ExpirePaymentService", () => {
  let service: ExpirePaymentService;
  let paymentRepository: {
    expirePendingPaymentPastExpiry: jest.MockedFunction<
      PaymentRepository["expirePendingPaymentPastExpiry"]
    >;
  };
  let bookingRepository: {
    expirePendingBookingPastExpiry: jest.MockedFunction<
      BookingRepository["expirePendingBookingPastExpiry"]
    >;
    findBookingSeatsByBookingId: jest.MockedFunction<BookingRepository["findBookingSeatsByBookingId"]>;
  };
  let screeningRepository: {
    releaseBookedSeats: jest.MockedFunction<ScreeningRepository["releaseBookedSeats"]>;
  };
  let transaction: jest.MockedFunction<RunTransaction>;

  beforeEach(async () => {
    paymentRepository = {
      expirePendingPaymentPastExpiry: jest.fn<PaymentRepository["expirePendingPaymentPastExpiry"]>(),
    };
    bookingRepository = {
      expirePendingBookingPastExpiry: jest.fn<BookingRepository["expirePendingBookingPastExpiry"]>(),
      findBookingSeatsByBookingId: jest.fn<BookingRepository["findBookingSeatsByBookingId"]>(),
    };
    screeningRepository = {
      releaseBookedSeats: jest.fn<ScreeningRepository["releaseBookedSeats"]>(),
    };
    transaction = jest.fn<RunTransaction>(async (callback) => callback(TX));
    jest.spyOn(Date, "now").mockReturnValue(NOW.getTime());

    const moduleRef = await Test.createTestingModule({
      providers: [
        BookingSeatReleaseService,
        ExpirePaymentService,
        {
          provide: PrismaService,
          useValue: { client: { $transaction: transaction } },
        },
        { provide: PaymentRepository, useValue: paymentRepository },
        { provide: BookingRepository, useValue: bookingRepository },
        { provide: ScreeningRepository, useValue: screeningRepository },
      ],
    }).compile();

    service = moduleRef.get(ExpirePaymentService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("expires a pending payment, its booking, and releases its seats", async () => {
    paymentRepository.expirePendingPaymentPastExpiry.mockResolvedValue({
      count: 1,
      bookingId: BOOKING_ID,
    });
    bookingRepository.expirePendingBookingPastExpiry.mockResolvedValue({ count: 1 });
    bookingRepository.findBookingSeatsByBookingId.mockResolvedValue(
      SCREENING_SEAT_IDS.map((screeningSeatId) => ({ screeningSeatId })),
    );
    screeningRepository.releaseBookedSeats.mockResolvedValue({
      count: SCREENING_SEAT_IDS.length,
    });

    await expect(service.execute(PAYMENT_ID)).resolves.toEqual({
      result: EXPIRE_DUE_PAYMENT_RESULT.EXPIRED,
    });

    expect(paymentRepository.expirePendingPaymentPastExpiry).toHaveBeenCalledWith(
      TX,
      PAYMENT_ID,
      NOW,
    );
    expect(bookingRepository.expirePendingBookingPastExpiry).toHaveBeenCalledWith(
      TX,
      BOOKING_ID,
      NOW,
    );
    expect(screeningRepository.releaseBookedSeats).toHaveBeenCalledWith(TX, SCREENING_SEAT_IDS);
    expect(paymentRepository.expirePendingPaymentPastExpiry.mock.invocationCallOrder[0]).toBeLessThan(
      bookingRepository.expirePendingBookingPastExpiry.mock.invocationCallOrder[0] ?? 0,
    );
    expect(bookingRepository.expirePendingBookingPastExpiry.mock.invocationCallOrder[0]).toBeLessThan(
      screeningRepository.releaseBookedSeats.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it.each([
    "the booking hold has not ended",
    "the payment is no longer pending",
    "the booking is no longer pending",
    "another execution already expired the payment",
  ])("returns not eligible when %s", async () => {
    paymentRepository.expirePendingPaymentPastExpiry.mockResolvedValue({
      count: 0,
      bookingId: null,
    });

    await expect(service.execute(PAYMENT_ID)).resolves.toEqual({
      result: EXPIRE_DUE_PAYMENT_RESULT.NOT_ELIGIBLE,
    });

    expect(bookingRepository.expirePendingBookingPastExpiry).not.toHaveBeenCalled();
    expect(bookingRepository.findBookingSeatsByBookingId).not.toHaveBeenCalled();
    expect(screeningRepository.releaseBookedSeats).not.toHaveBeenCalled();
  });

  it("rolls the expiration back when the booking cannot be expired", async () => {
    paymentRepository.expirePendingPaymentPastExpiry.mockResolvedValue({
      count: 1,
      bookingId: BOOKING_ID,
    });
    bookingRepository.expirePendingBookingPastExpiry.mockResolvedValue({ count: 0 });

    await expect(service.execute(PAYMENT_ID)).rejects.toThrow(InternalServerErrorException);

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(bookingRepository.findBookingSeatsByBookingId).not.toHaveBeenCalled();
    expect(screeningRepository.releaseBookedSeats).not.toHaveBeenCalled();
  });

  it("rolls the expiration back when a booked seat cannot be released", async () => {
    paymentRepository.expirePendingPaymentPastExpiry.mockResolvedValue({
      count: 1,
      bookingId: BOOKING_ID,
    });
    bookingRepository.expirePendingBookingPastExpiry.mockResolvedValue({ count: 1 });
    bookingRepository.findBookingSeatsByBookingId.mockResolvedValue(
      SCREENING_SEAT_IDS.map((screeningSeatId) => ({ screeningSeatId })),
    );
    screeningRepository.releaseBookedSeats.mockResolvedValue({ count: 1 });

    await expect(service.execute(PAYMENT_ID)).rejects.toThrow(InternalServerErrorException);
    expect(transaction).toHaveBeenCalledTimes(1);
  });
});
