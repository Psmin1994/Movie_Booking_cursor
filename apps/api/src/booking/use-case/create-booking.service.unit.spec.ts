/**
 * Test Intent:
 * 아직 시작하지 않은 상영의 예약 가능 좌석만으로, 결제 없이 PENDING Booking과 좌석 점유가 함께 성립함을 보장한다. 상영이나 좌석이 없거나 점유 수가 요청과 맞지 않으면 예매는 성립하지 않는다.
 */

import { jest } from "@jest/globals";
import { Prisma } from "@movie-booking/database-prisma";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PrismaService } from "../../database/prisma.service.js";
import { ScreeningRepository } from "../../screening/repository/screening.repository.js";
import { BOOKING_PAYMENT_WINDOW_MS, BOOKING_PENDING_STATUS, SEAT_PRICE } from "../booking.constants.js";
import { BookingRepository } from "../repository/booking.repository.js";
import { CreateBookingService } from "./create-booking.service.js";

const USER_ID = "550e8400-e29b-41d4-a716-446655440000";
const SCREENING_ID = "550e8400-e29b-41d4-a716-446655440002";
const FIRST_SCREENING_SEAT_ID = "550e8400-e29b-41d4-a716-446655440010";
const SCREENING_SEAT_IDS = [
  FIRST_SCREENING_SEAT_ID,
  "550e8400-e29b-41d4-a716-446655440011",
];
const CREATED_AT = "2026-09-20T10:30:00.000Z";
const NOW = Date.parse("2026-09-24T09:00:00.000Z");
const FUTURE_START_AT = new Date("2026-09-24T10:30:00.000Z");
const FUTURE_SCREENING = { id: SCREENING_ID, startAt: FUTURE_START_AT };
const USER = { id: USER_ID, email: "user@example.com" };
const DTO = {
  screeningId: SCREENING_ID,
  screeningSeatIds: SCREENING_SEAT_IDS,
};
const TX = { name: "transaction-client" } as unknown as Prisma.TransactionClient;

type ScreeningRepositoryMocks = {
  [K in "findScreeningById" | "findScreeningSeatsByIds" | "occupyAvailableSeats"]: jest.MockedFunction<
    ScreeningRepository[K]
  >;
};

type BookingRepositoryMocks = {
  [K in "createBooking" | "createBookingSeats"]: jest.MockedFunction<BookingRepository[K]>;
};

type RunTransaction = (
  callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
) => Promise<unknown>;

describe("CreateBookingService", () => {
  let service: CreateBookingService;
  let screeningRepository: ScreeningRepositoryMocks;
  let bookingRepository: BookingRepositoryMocks;
  let transaction: jest.MockedFunction<RunTransaction>;

  beforeEach(async () => {
    jest.spyOn(Date, "now").mockReturnValue(NOW);

    screeningRepository = {
      findScreeningById: jest.fn<ScreeningRepository["findScreeningById"]>(),
      findScreeningSeatsByIds: jest.fn<ScreeningRepository["findScreeningSeatsByIds"]>(),
      occupyAvailableSeats: jest.fn<ScreeningRepository["occupyAvailableSeats"]>(),
    };
    bookingRepository = {
      createBooking: jest.fn<BookingRepository["createBooking"]>(),
      createBookingSeats: jest.fn<BookingRepository["createBookingSeats"]>(),
    };
    transaction = jest.fn<RunTransaction>(async (callback) => callback(TX));

    const moduleRef = await Test.createTestingModule({
      providers: [
        CreateBookingService,
        {
          provide: PrismaService,
          useValue: {
            client: {
              $transaction: transaction,
            },
          },
        },
        {
          provide: ScreeningRepository,
          useValue: screeningRepository,
        },
        {
          provide: BookingRepository,
          useValue: bookingRepository,
        },
      ],
    }).compile();

    service = moduleRef.get(CreateBookingService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("creates a booking and booking seats without a payment", async () => {
    screeningRepository.findScreeningById.mockResolvedValue(FUTURE_SCREENING);
    screeningRepository.findScreeningSeatsByIds.mockResolvedValue(
      SCREENING_SEAT_IDS.map((id) => ({ id })),
    );
    screeningRepository.occupyAvailableSeats.mockResolvedValue({
      count: SCREENING_SEAT_IDS.length,
    });
    bookingRepository.createBooking.mockResolvedValue({
      id: "booking-1",
      userId: USER_ID,
      screeningId: SCREENING_ID,
      status: BOOKING_PENDING_STATUS,
      totalAmount: SCREENING_SEAT_IDS.length * SEAT_PRICE,
      createdAt: new Date(CREATED_AT),
      confirmedAt: null,
    });
    bookingRepository.createBookingSeats.mockResolvedValue({
      count: SCREENING_SEAT_IDS.length,
    });

    const result = await service.execute(USER, DTO);

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(screeningRepository.findScreeningById).toHaveBeenCalledWith(SCREENING_ID, TX);
    expect(screeningRepository.findScreeningSeatsByIds).toHaveBeenCalledWith(
      TX,
      SCREENING_ID,
      SCREENING_SEAT_IDS,
    );
    expect(screeningRepository.occupyAvailableSeats).toHaveBeenCalledWith(
      TX,
      SCREENING_ID,
      SCREENING_SEAT_IDS,
    );
    expect(bookingRepository.createBooking).toHaveBeenCalledWith(TX, {
      userId: USER_ID,
      screeningId: SCREENING_ID,
      status: BOOKING_PENDING_STATUS,
      totalAmount: SCREENING_SEAT_IDS.length * SEAT_PRICE,
      confirmedAt: null,
      expiresAt: new Date(NOW + BOOKING_PAYMENT_WINDOW_MS),
    });
    expect(bookingRepository.createBookingSeats).toHaveBeenCalledWith(
      TX,
      "booking-1",
      SCREENING_SEAT_IDS,
    );
    expect(screeningRepository.occupyAvailableSeats.mock.invocationCallOrder[0]).toBeLessThan(
      bookingRepository.createBooking.mock.invocationCallOrder[0] ?? 0,
    );
    expect(result).toEqual({
      id: "booking-1",
    });
  });

  it("stores the seat price for one seat", async () => {
    const seatIds = [FIRST_SCREENING_SEAT_ID];

    screeningRepository.findScreeningById.mockResolvedValue(FUTURE_SCREENING);
    screeningRepository.findScreeningSeatsByIds.mockResolvedValue(seatIds.map((id) => ({ id })));
    screeningRepository.occupyAvailableSeats.mockResolvedValue({
      count: seatIds.length,
    });
    bookingRepository.createBooking.mockResolvedValue({
      id: "booking-1",
      userId: USER_ID,
      screeningId: SCREENING_ID,
      status: BOOKING_PENDING_STATUS,
      totalAmount: SEAT_PRICE,
      createdAt: new Date(CREATED_AT),
      confirmedAt: null,
    });
    bookingRepository.createBookingSeats.mockResolvedValue({
      count: seatIds.length,
    });

    await service.execute(USER, {
      screeningId: SCREENING_ID,
      screeningSeatIds: seatIds,
    });

    expect(bookingRepository.createBooking).toHaveBeenCalledWith(TX, {
      userId: USER_ID,
      screeningId: SCREENING_ID,
      status: BOOKING_PENDING_STATUS,
      totalAmount: SEAT_PRICE,
      confirmedAt: null,
      expiresAt: new Date(NOW + BOOKING_PAYMENT_WINDOW_MS),
    });
  });

  it("throws when the screening does not exist", async () => {
    screeningRepository.findScreeningById.mockResolvedValue(null);

    await expect(service.execute(USER, DTO)).rejects.toThrow(NotFoundException);

    expect(screeningRepository.findScreeningSeatsByIds).not.toHaveBeenCalled();
    expect(screeningRepository.occupyAvailableSeats).not.toHaveBeenCalled();
    expect(bookingRepository.createBooking).not.toHaveBeenCalled();
  });

  it("throws when requested screening seats are missing or not in the screening", async () => {
    screeningRepository.findScreeningById.mockResolvedValue(FUTURE_SCREENING);
    screeningRepository.findScreeningSeatsByIds.mockResolvedValue([{ id: FIRST_SCREENING_SEAT_ID }]);

    await expect(service.execute(USER, DTO)).rejects.toThrow(NotFoundException);

    expect(screeningRepository.occupyAvailableSeats).not.toHaveBeenCalled();
    expect(bookingRepository.createBooking).not.toHaveBeenCalled();
  });

  it("throws when occupied seat count does not match the requested seat count", async () => {
    screeningRepository.findScreeningById.mockResolvedValue(FUTURE_SCREENING);
    screeningRepository.findScreeningSeatsByIds.mockResolvedValue(
      SCREENING_SEAT_IDS.map((id) => ({ id })),
    );
    screeningRepository.occupyAvailableSeats.mockResolvedValue({ count: 1 });

    await expect(service.execute(USER, DTO)).rejects.toThrow(ConflictException);

    expect(bookingRepository.createBooking).not.toHaveBeenCalled();
    expect(bookingRepository.createBookingSeats).not.toHaveBeenCalled();
    await expect(transaction.mock.results[0]?.value).rejects.toThrow(ConflictException);
  });

  it("rejects a screening whose startAt is before now", async () => {
    screeningRepository.findScreeningById.mockResolvedValue({
      id: SCREENING_ID,
      startAt: new Date(NOW - 1),
    });

    await expect(service.execute(USER, DTO)).rejects.toThrow(
      new ConflictException("이미 시작된 상영은 예약할 수 없습니다."),
    );

    expect(screeningRepository.findScreeningSeatsByIds).not.toHaveBeenCalled();
    expect(screeningRepository.occupyAvailableSeats).not.toHaveBeenCalled();
    expect(bookingRepository.createBooking).not.toHaveBeenCalled();
  });

  it("rejects a screening whose startAt is equal to now", async () => {
    screeningRepository.findScreeningById.mockResolvedValue({
      id: SCREENING_ID,
      startAt: new Date(NOW),
    });

    await expect(service.execute(USER, DTO)).rejects.toThrow(
      new ConflictException("이미 시작된 상영은 예약할 수 없습니다."),
    );

    expect(screeningRepository.findScreeningSeatsByIds).not.toHaveBeenCalled();
    expect(screeningRepository.occupyAvailableSeats).not.toHaveBeenCalled();
    expect(bookingRepository.createBooking).not.toHaveBeenCalled();
  });
});
