/**
 * Test Intent:
 * 인증 사용자 소유의 예매 상세만 반환함을 보장한다. 상세에는 서버가 저장한 결제 만료 시각, 결제 정보, 그 결제에 연결된 환불이 포함된다. 결제가 없으면 payment는 null이다. 환불이 없으면 refunds는 빈 배열이다. 소유 예매가 없으면 찾을 수 없고, 취소된 예매도 소유자면 상세를 반환한다.
 * 인증 사용자의 예매만 영화, 상영, 상영관, 좌석과 함께 목록으로 반환함을 보장한다. 예매가 없으면 빈 목록이다.
 */

import { jest } from "@jest/globals";
import { NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import {
  BOOKING_CANCELLED_STATUS,
  BOOKING_CONFIRMED_STATUS,
} from "../booking.constants.js";
import { BookingRepository } from "../repository/booking.repository.js";
import { SelectBookingService } from "./select-booking.service.js";

const USER_ID = "550e8400-e29b-41d4-a716-446655440000";
const USER = { id: USER_ID, email: "user@example.com" };
const BOOKING_ID = "550e8400-e29b-41d4-a716-446655440020";
const MOVIE_ID = "550e8400-e29b-41d4-a716-446655440000";
const SCREENING_ID = "550e8400-e29b-41d4-a716-446655440002";
const SCREEN_ID = "550e8400-e29b-41d4-a716-446655440001";
const SCREENING_SEAT_ID = "550e8400-e29b-41d4-a716-446655440010";
const CREATED_AT = "2026-09-20T10:00:00.000Z";
const EXPIRES_AT = "2026-09-20T10:10:00.000Z";
const CONFIRMED_AT = "2026-09-20T10:30:00.000Z";
const CANCELLED_AT = "2026-09-21T01:00:00.000Z";
const START_AT = "2026-09-20T01:00:00.000Z";
const PAYMENT_ID = "550e8400-e29b-41d4-a716-446655440030";
const ORDER_ID = "ord_550e8400-e29b-41d4-a716-446655440030";
const REFUND_ID = "550e8400-e29b-41d4-a716-446655440040";
const REFUND_COMPLETED_AT = "2026-09-21T02:00:00.000Z";

function createDetailRecord(overrides?: {
  status?: string;
  confirmedAt?: Date | null;
  cancelledAt?: Date | null;
  payment?: null;
  refunds?: Array<{
    id: string;
    amount: number;
    status: string;
    completedAt: Date | null;
    failedAt: Date | null;
  }>;
}) {
  return {
    id: BOOKING_ID,
    status: overrides?.status ?? BOOKING_CONFIRMED_STATUS,
    createdAt: new Date(CREATED_AT),
    expiresAt: new Date(EXPIRES_AT),
    confirmedAt:
      overrides?.confirmedAt !== undefined
        ? overrides.confirmedAt
        : new Date(CONFIRMED_AT),
    cancelledAt:
      overrides?.cancelledAt !== undefined ? overrides.cancelledAt : null,
    screening: {
      id: SCREENING_ID,
      startAt: new Date(START_AT),
      movie: {
        id: MOVIE_ID,
        title: "Inception",
      },
      screen: {
        id: SCREEN_ID,
        number: 1,
        floor: 2,
        screenType: "IMAX",
      },
    },
    bookingSeats: [
      {
        screeningSeat: {
          id: SCREENING_SEAT_ID,
          seat: {
            row: "A",
            number: 1,
          },
        },
      },
    ],
    payment:
      overrides?.payment === null
        ? null
        : {
            id: PAYMENT_ID,
            orderId: ORDER_ID,
            amount: 10_000,
            status: "PAID",
            paidAt: new Date(CONFIRMED_AT),
            refunds: overrides?.refunds ?? [],
          },
  };
}

function createListRecord(overrides?: {
  status?: string;
  confirmedAt?: Date | null;
  bookingSeats?: Array<{
    screeningSeat: {
      id: string;
      seat: { row: string; number: number };
    };
  }>;
}) {
  return {
    id: BOOKING_ID,
    status: overrides?.status ?? BOOKING_CONFIRMED_STATUS,
    confirmedAt:
      overrides?.confirmedAt !== undefined
        ? overrides.confirmedAt
        : new Date(CONFIRMED_AT),
    screening: {
      id: SCREENING_ID,
      startAt: new Date(START_AT),
      movie: {
        id: MOVIE_ID,
        title: "Inception",
      },
      screen: {
        id: SCREEN_ID,
        number: 1,
        floor: 2,
        screenType: "IMAX",
      },
    },
    bookingSeats:
      overrides?.bookingSeats ?? [
        {
          screeningSeat: {
            id: SCREENING_SEAT_ID,
            seat: {
              row: "A",
              number: 1,
            },
          },
        },
      ],
  };
}

type FindBookingDetailByIdAndUserId =
  BookingRepository["findBookingDetailByIdAndUserId"];
type FindBookingsByUserId = BookingRepository["findBookingsByUserId"];

describe("SelectBookingService", () => {
  let service: SelectBookingService;
  let bookingRepository: {
    findBookingDetailByIdAndUserId: jest.MockedFunction<FindBookingDetailByIdAndUserId>;
    findBookingsByUserId: jest.MockedFunction<FindBookingsByUserId>;
  };

  beforeEach(async () => {
    bookingRepository = {
      findBookingDetailByIdAndUserId: jest.fn<FindBookingDetailByIdAndUserId>(),
      findBookingsByUserId: jest.fn<FindBookingsByUserId>(),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        SelectBookingService,
        {
          provide: BookingRepository,
          useValue: bookingRepository,
        },
      ],
    }).compile();

    service = moduleRef.get(SelectBookingService);
  });

  it("returns a detail DTO when the booking belongs to the authenticated user", async () => {
    bookingRepository.findBookingDetailByIdAndUserId.mockResolvedValue(
      createDetailRecord(),
    );

    const result = await service.getBookingDetail(USER, BOOKING_ID);

    expect(
      bookingRepository.findBookingDetailByIdAndUserId,
    ).toHaveBeenCalledWith(BOOKING_ID, USER_ID);
    expect(bookingRepository.findBookingsByUserId).not.toHaveBeenCalled();
    expect(result).toEqual({
      id: BOOKING_ID,
      status: BOOKING_CONFIRMED_STATUS,
      createdAt: CREATED_AT,
      expiresAt: EXPIRES_AT,
      confirmedAt: CONFIRMED_AT,
      cancelledAt: null,
      movie: {
        id: MOVIE_ID,
        title: "Inception",
      },
      screening: {
        id: SCREENING_ID,
        startAt: START_AT,
      },
      screen: {
        id: SCREEN_ID,
        number: 1,
        floor: 2,
        screenType: "IMAX",
      },
      seats: [
        {
          id: SCREENING_SEAT_ID,
          row: "A",
          number: 1,
        },
      ],
      payment: {
        id: PAYMENT_ID,
        orderId: ORDER_ID,
        amount: 10_000,
        status: "PAID",
        paidAt: CONFIRMED_AT,
        refunds: [],
      },
    });
  });

  it("maps payment refunds onto the booking detail", async () => {
    bookingRepository.findBookingDetailByIdAndUserId.mockResolvedValue(
      createDetailRecord({
        refunds: [
          {
            id: REFUND_ID,
            amount: 10_000,
            status: "COMPLETED",
            completedAt: new Date(REFUND_COMPLETED_AT),
            failedAt: null,
          },
        ],
      }),
    );

    const result = await service.getBookingDetail(USER, BOOKING_ID);

    expect(result.payment?.refunds).toEqual([
      {
        id: REFUND_ID,
        amount: 10_000,
        status: "COMPLETED",
        completedAt: REFUND_COMPLETED_AT,
        failedAt: null,
      },
    ]);
  });

  it("throws NotFoundException when the repository returns null", async () => {
    bookingRepository.findBookingDetailByIdAndUserId.mockResolvedValue(null);

    await expect(service.getBookingDetail(USER, BOOKING_ID)).rejects.toThrow(
      NotFoundException,
    );
    await expect(service.getBookingDetail(USER, BOOKING_ID)).rejects.toThrow(
      "예매를 찾을 수 없습니다.",
    );
  });

  it("passes the authenticated user id and booking id to the repository", async () => {
    bookingRepository.findBookingDetailByIdAndUserId.mockResolvedValue(
      createDetailRecord(),
    );

    await service.getBookingDetail(USER, BOOKING_ID);

    expect(
      bookingRepository.findBookingDetailByIdAndUserId,
    ).toHaveBeenCalledWith(BOOKING_ID, USER_ID);
  });

  it("returns a cancelled booking", async () => {
    bookingRepository.findBookingDetailByIdAndUserId.mockResolvedValue(
      createDetailRecord({
        status: BOOKING_CANCELLED_STATUS,
        cancelledAt: new Date(CANCELLED_AT),
      }),
    );

    const result = await service.getBookingDetail(USER, BOOKING_ID);

    expect(result.status).toBe(BOOKING_CANCELLED_STATUS);
    expect(result.cancelledAt).toBe(CANCELLED_AT);
    expect(result.confirmedAt).toBe(CONFIRMED_AT);
  });

  it("returns a detail without payment when the booking has no payment", async () => {
    bookingRepository.findBookingDetailByIdAndUserId.mockResolvedValue(
      createDetailRecord({ payment: null }),
    );

    const result = await service.getBookingDetail(USER, BOOKING_ID);

    expect(result.payment).toBeNull();
  });

  it("calls the repository with the authenticated user id and maps nested results to DTOs", async () => {
    bookingRepository.findBookingsByUserId.mockResolvedValue([
      createListRecord(),
    ]);

    const result = await service.getMyBookings(USER);

    expect(bookingRepository.findBookingsByUserId).toHaveBeenCalledWith(
      USER_ID,
    );
    expect(
      bookingRepository.findBookingDetailByIdAndUserId,
    ).not.toHaveBeenCalled();
    expect(result).toEqual([
      {
        id: BOOKING_ID,
        status: BOOKING_CONFIRMED_STATUS,
        confirmedAt: CONFIRMED_AT,
        movie: {
          id: MOVIE_ID,
          title: "Inception",
        },
        screening: {
          id: SCREENING_ID,
          startAt: START_AT,
        },
        screen: {
          id: SCREEN_ID,
          number: 1,
          floor: 2,
          screenType: "IMAX",
        },
        seats: [
          {
            id: SCREENING_SEAT_ID,
            row: "A",
            number: 1,
          },
        ],
      },
    ]);
    expect(result[0]).not.toHaveProperty("payment");
    expect(result[0]).not.toHaveProperty("createdAt");
    expect(result[0]).not.toHaveProperty("expiresAt");
    expect(result[0]).not.toHaveProperty("cancelledAt");
  });

  it("returns an empty array when the user has no bookings", async () => {
    bookingRepository.findBookingsByUserId.mockResolvedValue([]);

    const result = await service.getMyBookings(USER);

    expect(bookingRepository.findBookingsByUserId).toHaveBeenCalledWith(
      USER_ID,
    );
    expect(result).toEqual([]);
  });

  it("maps null confirmedAt to null", async () => {
    bookingRepository.findBookingsByUserId.mockResolvedValue([
      createListRecord({ confirmedAt: null }),
    ]);

    const result = await service.getMyBookings(USER);

    expect(result).toHaveLength(1);
    expect(result[0]?.confirmedAt).toBeNull();
  });

  it("maps empty bookingSeats to an empty seats array", async () => {
    bookingRepository.findBookingsByUserId.mockResolvedValue([
      createListRecord({ bookingSeats: [] }),
    ]);

    const result = await service.getMyBookings(USER);

    expect(result).toHaveLength(1);
    expect(result[0]?.seats).toEqual([]);
    expect(result[0]?.movie.id).toBe(MOVIE_ID);
    expect(result[0]?.screening.id).toBe(SCREENING_ID);
    expect(result[0]?.screen.id).toBe(SCREEN_ID);
  });

  it("returns a cancelled booking in the user's list", async () => {
    bookingRepository.findBookingsByUserId.mockResolvedValue([
      createListRecord({
        status: BOOKING_CANCELLED_STATUS,
        confirmedAt: new Date(CONFIRMED_AT),
      }),
    ]);

    const result = await service.getMyBookings(USER);

    expect(result[0]?.status).toBe(BOOKING_CANCELLED_STATUS);
    expect(result[0]?.confirmedAt).toBe(CONFIRMED_AT);
  });
});
