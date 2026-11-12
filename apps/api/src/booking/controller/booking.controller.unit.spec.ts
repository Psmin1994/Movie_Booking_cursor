/**
 * Test Intent:
 * 인증 사용자의 예매 목록과 상세 조회는 SelectBookingService의 결과와 예외를 그대로 반환한다.
 */

import { jest } from "@jest/globals";
import { NotFoundException } from "@nestjs/common";
import { CancelBookingService } from "../use-case/cancel-booking.service.js";
import { CreateBookingService } from "../use-case/create-booking.service.js";
import { SelectBookingService } from "../use-case/select-booking.service.js";
import { BookingController } from "./booking.controller.js";

const USER = {
  id: "550e8400-e29b-41d4-a716-446655440000",
  email: "user@example.com",
};
const BOOKING_ID = "550e8400-e29b-41d4-a716-446655440020";

describe("BookingController booking queries", () => {
  let controller: BookingController;
  let selectBookingService: {
    getMyBookings: jest.MockedFunction<SelectBookingService["getMyBookings"]>;
    getBookingDetail: jest.MockedFunction<SelectBookingService["getBookingDetail"]>;
  };

  beforeEach(() => {
    selectBookingService = {
      getMyBookings: jest.fn<SelectBookingService["getMyBookings"]>(),
      getBookingDetail: jest.fn<SelectBookingService["getBookingDetail"]>(),
    };

    controller = new BookingController(
      {} as CreateBookingService,
      selectBookingService as unknown as SelectBookingService,
      {} as CancelBookingService,
    );
  });

  it("returns the authenticated user's bookings from SelectBookingService", async () => {
    const bookings = [
      {
        id: BOOKING_ID,
        status: "CONFIRMED",
        confirmedAt: "2026-09-20T10:30:00.000Z",
        movie: { id: "movie", title: "Inception" },
        screening: { id: "screening", startAt: "2026-09-20T01:00:00.000Z" },
        screen: { id: "screen", number: 1, floor: 2, screenType: "IMAX" },
        seats: [{ id: "seat", row: "A", number: 1 }],
      },
    ];
    selectBookingService.getMyBookings.mockResolvedValue(bookings);

    const result = await controller.getMyBookings(USER);

    expect(selectBookingService.getMyBookings).toHaveBeenCalledWith(USER);
    expect(result).toBe(bookings);
  });

  it("returns the authenticated user's booking detail from SelectBookingService", async () => {
    const detail = {
      id: BOOKING_ID,
      status: "CONFIRMED",
      createdAt: "2026-09-20T10:00:00.000Z",
      expiresAt: "2026-09-20T10:10:00.000Z",
      confirmedAt: "2026-09-20T10:30:00.000Z",
      cancelledAt: null,
      movie: { id: "movie", title: "Inception" },
      screening: { id: "screening", startAt: "2026-09-20T01:00:00.000Z" },
      screen: { id: "screen", number: 1, floor: 2, screenType: "IMAX" },
      seats: [{ id: "seat", row: "A", number: 1 }],
      payment: null,
    };
    selectBookingService.getBookingDetail.mockResolvedValue(detail);

    const result = await controller.getBookingDetail(USER, BOOKING_ID);

    expect(selectBookingService.getBookingDetail).toHaveBeenCalledWith(
      USER,
      BOOKING_ID,
    );
    expect(result).toBe(detail);
  });

  it("propagates NotFoundException when the booking detail is missing", async () => {
    selectBookingService.getBookingDetail.mockRejectedValue(
      new NotFoundException("예매를 찾을 수 없습니다."),
    );

    await expect(controller.getBookingDetail(USER, BOOKING_ID)).rejects.toThrow(
      NotFoundException,
    );
    await expect(controller.getBookingDetail(USER, BOOKING_ID)).rejects.toThrow(
      "예매를 찾을 수 없습니다.",
    );
  });
});
