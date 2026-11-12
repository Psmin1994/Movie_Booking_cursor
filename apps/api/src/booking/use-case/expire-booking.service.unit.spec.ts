/**
 * Test Intent:
 * 결제가 없는 PENDING Booking만 만료되고 점유 좌석이 해제됨을 보장한다. 만료 대상이 아니면 좌석을 풀지 않고, 좌석 해제가 맞지 않으면 만료는 확정되지 않는다.
 */

import { jest } from "@jest/globals";
import { Prisma } from "@movie-booking/database-prisma";
import { InternalServerErrorException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PrismaService } from "../../database/prisma.service.js";
import { ScreeningRepository } from "../../screening/repository/screening.repository.js";
import { EXPIRE_BOOKING_RESULT } from "../booking.constants.js";
import { BookingRepository } from "../repository/booking.repository.js";
import { BookingSeatReleaseService } from "./booking-seat-release.service.js";
import { ExpireBookingService } from "./expire-booking.service.js";

const BOOKING_ID = "550e8400-e29b-41d4-a716-446655440020";
const SCREENING_SEAT_IDS = [
  "550e8400-e29b-41d4-a716-446655440010",
  "550e8400-e29b-41d4-a716-446655440011",
];
const TX = { name: "transaction-client" } as unknown as Prisma.TransactionClient;
const NOW = new Date("2026-09-28T12:00:00.000Z");

type RunTransaction = (
  callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
) => Promise<unknown>;

describe("ExpireBookingService", () => {
  let service: ExpireBookingService;
  let bookingRepository: {
    lockBookingById: jest.MockedFunction<BookingRepository["lockBookingById"]>;
    expirePendingBookingWithoutPayment: jest.MockedFunction<
      BookingRepository["expirePendingBookingWithoutPayment"]
    >;
    findBookingSeatsByBookingId: jest.MockedFunction<
      BookingRepository["findBookingSeatsByBookingId"]
    >;
  };
  let screeningRepository: {
    releaseBookedSeats: jest.MockedFunction<ScreeningRepository["releaseBookedSeats"]>;
  };
  let transaction: jest.MockedFunction<RunTransaction>;

  beforeEach(async () => {
    bookingRepository = {
      lockBookingById: jest.fn<BookingRepository["lockBookingById"]>(),
      expirePendingBookingWithoutPayment:
        jest.fn<BookingRepository["expirePendingBookingWithoutPayment"]>(),
      findBookingSeatsByBookingId:
        jest.fn<BookingRepository["findBookingSeatsByBookingId"]>(),
    };
    screeningRepository = {
      releaseBookedSeats: jest.fn<ScreeningRepository["releaseBookedSeats"]>(),
    };
    transaction = jest.fn<RunTransaction>(async (callback) => callback(TX));
    jest.spyOn(Date, "now").mockReturnValue(NOW.getTime());

    const moduleRef = await Test.createTestingModule({
      providers: [
        BookingSeatReleaseService,
        ExpireBookingService,
        {
          provide: PrismaService,
          useValue: { client: { $transaction: transaction } },
        },
        { provide: BookingRepository, useValue: bookingRepository },
        { provide: ScreeningRepository, useValue: screeningRepository },
      ],
    }).compile();

    service = moduleRef.get(ExpireBookingService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("expires a pending booking without a payment and releases its seats", async () => {
    bookingRepository.expirePendingBookingWithoutPayment.mockResolvedValue({ count: 1 });
    bookingRepository.findBookingSeatsByBookingId.mockResolvedValue(
      SCREENING_SEAT_IDS.map((screeningSeatId) => ({ screeningSeatId })),
    );
    screeningRepository.releaseBookedSeats.mockResolvedValue({
      count: SCREENING_SEAT_IDS.length,
    });

    await expect(service.execute(BOOKING_ID)).resolves.toEqual({
      result: EXPIRE_BOOKING_RESULT.EXPIRED,
    });

    expect(bookingRepository.lockBookingById).toHaveBeenCalledWith(TX, BOOKING_ID);
    expect(bookingRepository.lockBookingById.mock.invocationCallOrder[0]).toBeLessThan(
      bookingRepository.expirePendingBookingWithoutPayment.mock.invocationCallOrder[0] ?? 0,
    );
    expect(bookingRepository.expirePendingBookingWithoutPayment).toHaveBeenCalledWith(
      TX,
      BOOKING_ID,
      NOW,
    );
    expect(screeningRepository.releaseBookedSeats).toHaveBeenCalledWith(TX, SCREENING_SEAT_IDS);
    expect(bookingRepository.expirePendingBookingWithoutPayment.mock.invocationCallOrder[0]).toBeLessThan(
      screeningRepository.releaseBookedSeats.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("does not release seats when the booking is not eligible", async () => {
    bookingRepository.expirePendingBookingWithoutPayment.mockResolvedValue({ count: 0 });

    await expect(service.execute(BOOKING_ID)).resolves.toEqual({
      result: EXPIRE_BOOKING_RESULT.NOT_ELIGIBLE,
    });

    expect(bookingRepository.findBookingSeatsByBookingId).not.toHaveBeenCalled();
    expect(screeningRepository.releaseBookedSeats).not.toHaveBeenCalled();
  });

  it("rolls the expiration back when a booked seat cannot be released", async () => {
    bookingRepository.expirePendingBookingWithoutPayment.mockResolvedValue({ count: 1 });
    bookingRepository.findBookingSeatsByBookingId.mockResolvedValue(
      SCREENING_SEAT_IDS.map((screeningSeatId) => ({ screeningSeatId })),
    );
    screeningRepository.releaseBookedSeats.mockResolvedValue({ count: 1 });

    await expect(service.execute(BOOKING_ID)).rejects.toThrow(InternalServerErrorException);
    expect(transaction).toHaveBeenCalledTimes(1);
  });
});
