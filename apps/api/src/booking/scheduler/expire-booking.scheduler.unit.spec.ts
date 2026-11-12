/**
 * Test Intent:
 * 만료 대상 Booking을 한 건씩 앞선 처리가 끝난 뒤에만 처리함을 보장한다. 한 건이 대상이 아니거나 실패해도 다음 대상은 계속 처리한다.
 */

import { jest } from "@jest/globals";
import { Logger } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { EXPIRE_BOOKING_RESULT } from "../booking.constants.js";
import { BookingRepository } from "../repository/booking.repository.js";
import { ExpireBookingScheduler } from "./expire-booking.scheduler.js";
import { ExpireBookingService } from "../use-case/expire-booking.service.js";

const NOW = new Date("2026-09-28T12:00:00.000Z");
const FIRST_BOOKING_ID = "550e8400-e29b-41d4-a716-446655440021";
const SECOND_BOOKING_ID = "550e8400-e29b-41d4-a716-446655440022";
const THIRD_BOOKING_ID = "550e8400-e29b-41d4-a716-446655440023";
const BATCH_LIMIT = 100;

describe("ExpireBookingScheduler", () => {
  let scheduler: ExpireBookingScheduler;
  let bookingRepository: {
    findExpiredPendingBookingIdsWithoutPayment: jest.MockedFunction<
      BookingRepository["findExpiredPendingBookingIdsWithoutPayment"]
    >;
  };
  let expireBookingService: {
    execute: jest.MockedFunction<ExpireBookingService["execute"]>;
  };
  let loggerError: jest.SpiedFunction<Logger["error"]>;

  beforeEach(async () => {
    bookingRepository = {
      findExpiredPendingBookingIdsWithoutPayment:
        jest.fn<BookingRepository["findExpiredPendingBookingIdsWithoutPayment"]>(),
    };
    expireBookingService = {
      execute: jest.fn<ExpireBookingService["execute"]>(),
    };
    loggerError = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    jest.spyOn(Date, "now").mockReturnValue(NOW.getTime());

    const moduleRef = await Test.createTestingModule({
      providers: [
        ExpireBookingScheduler,
        { provide: BookingRepository, useValue: bookingRepository },
        { provide: ExpireBookingService, useValue: expireBookingService },
      ],
    }).compile();

    scheduler = moduleRef.get(ExpireBookingScheduler);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("expires each candidate only after the previous execution settles", async () => {
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const started: string[] = [];

    bookingRepository.findExpiredPendingBookingIdsWithoutPayment.mockResolvedValue([
      FIRST_BOOKING_ID,
      SECOND_BOOKING_ID,
    ]);
    expireBookingService.execute.mockImplementation(async (bookingId: string) => {
      started.push(bookingId);
      if (bookingId === FIRST_BOOKING_ID) {
        await firstBlocked;
      }
      return { result: EXPIRE_BOOKING_RESULT.EXPIRED };
    });

    const run = scheduler.expireDueBookings();
    await flush();

    expect(bookingRepository.findExpiredPendingBookingIdsWithoutPayment).toHaveBeenCalledWith(
      NOW,
      BATCH_LIMIT,
    );
    expect(started).toEqual([FIRST_BOOKING_ID]);

    releaseFirst();
    await run;

    expect(started).toEqual([FIRST_BOOKING_ID, SECOND_BOOKING_ID]);
    expect(loggerError).not.toHaveBeenCalled();
  });

  it("continues when a candidate is not eligible", async () => {
    bookingRepository.findExpiredPendingBookingIdsWithoutPayment.mockResolvedValue([
      FIRST_BOOKING_ID,
      SECOND_BOOKING_ID,
    ]);
    expireBookingService.execute.mockResolvedValue({
      result: EXPIRE_BOOKING_RESULT.NOT_ELIGIBLE,
    });

    await expect(scheduler.expireDueBookings()).resolves.toBeUndefined();

    expect(expireBookingService.execute).toHaveBeenNthCalledWith(1, FIRST_BOOKING_ID);
    expect(expireBookingService.execute).toHaveBeenNthCalledWith(2, SECOND_BOOKING_ID);
    expect(loggerError).not.toHaveBeenCalled();
  });

  it("continues with the next booking when one expiration throws", async () => {
    const failure = new Error("seat release failed");
    bookingRepository.findExpiredPendingBookingIdsWithoutPayment.mockResolvedValue([
      FIRST_BOOKING_ID,
      SECOND_BOOKING_ID,
      THIRD_BOOKING_ID,
    ]);
    expireBookingService.execute.mockImplementation(async (bookingId: string) => {
      if (bookingId === SECOND_BOOKING_ID) {
        throw failure;
      }
      return { result: EXPIRE_BOOKING_RESULT.EXPIRED };
    });

    await expect(scheduler.expireDueBookings()).resolves.toBeUndefined();

    expect(expireBookingService.execute).toHaveBeenNthCalledWith(1, FIRST_BOOKING_ID);
    expect(expireBookingService.execute).toHaveBeenNthCalledWith(2, SECOND_BOOKING_ID);
    expect(expireBookingService.execute).toHaveBeenNthCalledWith(3, THIRD_BOOKING_ID);
    expect(loggerError).toHaveBeenCalledTimes(1);
    expect(loggerError).toHaveBeenCalledWith(
      `Failed to expire booking ${SECOND_BOOKING_ID}`,
      failure.stack,
    );
  });
});

function flush(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}
