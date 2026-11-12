/**
 * Test Intent:
 * 기한이 지난 AUTHORIZING Payment만 RECONCILIATION_REQUIRED가 되고, 그 PENDING Booking은 CANCELLED가 되며 cancelledAt이 기록되고 점유 좌석이 해제됨을 보장한다. 그 전이가 성공하면 같은 트랜잭션에 대사 행이 생긴다. Payment 전이에 실패하면 예매, 좌석, 대사 행을 바꾸지 않고, 후속 건수가 맞지 않으면 복구는 확정되지 않는다.
 */

import { jest } from "@jest/globals";
import { Prisma } from "@movie-booking/database-prisma";
import { InternalServerErrorException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { BookingRepository } from "../../booking/repository/booking.repository.js";
import { BookingSeatReleaseService } from "../../booking/use-case/booking-seat-release.service.js";
import { PrismaService } from "../../database/prisma.service.js";
import { ScreeningRepository } from "../../screening/repository/screening.repository.js";
import { RECOVER_AUTHORIZING_PAYMENT_RESULT } from "../payment.constants.js";
import { PaymentRepository } from "../repository/payment.repository.js";
import { ReconcilePaymentRepository } from "../repository/reconcile-payment.repository.js";
import { RecoverAuthorizingPaymentService } from "./recover-authorizing-payment.service.js";

const USER_ID = "550e8400-e29b-41d4-a716-446655440000";
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

describe("RecoverAuthorizingPaymentService", () => {
  let service: RecoverAuthorizingPaymentService;
  let paymentRepository: {
    recoverAuthorizingPaymentPastDeadline: jest.MockedFunction<
      PaymentRepository["recoverAuthorizingPaymentPastDeadline"]
    >;
  };
  let bookingRepository: {
    cancelPendingBookingForReconciliation: jest.MockedFunction<
      BookingRepository["cancelPendingBookingForReconciliation"]
    >;
    findBookingSeatsByBookingId: jest.MockedFunction<BookingRepository["findBookingSeatsByBookingId"]>;
  };
  let screeningRepository: {
    releaseBookedSeats: jest.MockedFunction<ScreeningRepository["releaseBookedSeats"]>;
  };
  let reconcilePaymentRepository: {
    createOpen: jest.MockedFunction<ReconcilePaymentRepository["createOpen"]>;
  };
  let transaction: jest.MockedFunction<RunTransaction>;

  beforeEach(async () => {
    paymentRepository = {
      recoverAuthorizingPaymentPastDeadline:
        jest.fn<PaymentRepository["recoverAuthorizingPaymentPastDeadline"]>(),
    };
    bookingRepository = {
      cancelPendingBookingForReconciliation:
        jest.fn<BookingRepository["cancelPendingBookingForReconciliation"]>(),
      findBookingSeatsByBookingId: jest.fn<BookingRepository["findBookingSeatsByBookingId"]>(),
    };
    screeningRepository = {
      releaseBookedSeats: jest.fn<ScreeningRepository["releaseBookedSeats"]>(),
    };
    reconcilePaymentRepository = {
      createOpen: jest.fn<ReconcilePaymentRepository["createOpen"]>(),
    };
    reconcilePaymentRepository.createOpen.mockResolvedValue({
      id: "reconciliation-1",
      paymentId: PAYMENT_ID,
      createdAt: NOW,
      nextProcessAt: NOW,
    });
    transaction = jest.fn<RunTransaction>(async (callback) => callback(TX));
    jest.spyOn(Date, "now").mockReturnValue(NOW.getTime());

    const moduleRef = await Test.createTestingModule({
      providers: [
        BookingSeatReleaseService,
        RecoverAuthorizingPaymentService,
        {
          provide: PrismaService,
          useValue: { client: { $transaction: transaction } },
        },
        { provide: PaymentRepository, useValue: paymentRepository },
        { provide: BookingRepository, useValue: bookingRepository },
        { provide: ScreeningRepository, useValue: screeningRepository },
        { provide: ReconcilePaymentRepository, useValue: reconcilePaymentRepository },
      ],
    }).compile();

    service = moduleRef.get(RecoverAuthorizingPaymentService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("requires reconciliation, cancels the booking, and releases its seats", async () => {
    paymentRepository.recoverAuthorizingPaymentPastDeadline.mockResolvedValue({
      count: 1,
      bookingId: BOOKING_ID,
      userId: USER_ID,
    });
    bookingRepository.cancelPendingBookingForReconciliation.mockResolvedValue({ count: 1 });
    bookingRepository.findBookingSeatsByBookingId.mockResolvedValue(
      SCREENING_SEAT_IDS.map((screeningSeatId) => ({ screeningSeatId })),
    );
    screeningRepository.releaseBookedSeats.mockResolvedValue({
      count: SCREENING_SEAT_IDS.length,
    });

    await expect(service.execute(PAYMENT_ID)).resolves.toEqual({
      result: RECOVER_AUTHORIZING_PAYMENT_RESULT.RECONCILIATION_REQUIRED,
    });

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(paymentRepository.recoverAuthorizingPaymentPastDeadline).toHaveBeenCalledWith(
      TX,
      PAYMENT_ID,
      NOW,
    );
    expect(bookingRepository.cancelPendingBookingForReconciliation).toHaveBeenCalledWith(
      TX,
      BOOKING_ID,
      USER_ID,
      NOW,
    );
    expect(screeningRepository.releaseBookedSeats).toHaveBeenCalledWith(TX, SCREENING_SEAT_IDS);
    expect(reconcilePaymentRepository.createOpen).toHaveBeenCalledWith(TX, PAYMENT_ID, NOW);
    expect(
      screeningRepository.releaseBookedSeats.mock.invocationCallOrder[0],
    ).toBeLessThan(reconcilePaymentRepository.createOpen.mock.invocationCallOrder[0] ?? 0);
    expect(
      paymentRepository.recoverAuthorizingPaymentPastDeadline.mock.invocationCallOrder[0],
    ).toBeLessThan(
      bookingRepository.cancelPendingBookingForReconciliation.mock.invocationCallOrder[0] ?? 0,
    );
    expect(
      bookingRepository.cancelPendingBookingForReconciliation.mock.invocationCallOrder[0],
    ).toBeLessThan(screeningRepository.releaseBookedSeats.mock.invocationCallOrder[0] ?? 0);
  });

  it.each([
    "the authorization deadline has not passed",
    "the payment is no longer authorizing",
    "the booking is no longer pending",
    "another execution already recovered the payment",
  ])("returns not eligible when %s", async () => {
    paymentRepository.recoverAuthorizingPaymentPastDeadline.mockResolvedValue({
      count: 0,
      bookingId: null,
      userId: null,
    });

    await expect(service.execute(PAYMENT_ID)).resolves.toEqual({
      result: RECOVER_AUTHORIZING_PAYMENT_RESULT.NOT_ELIGIBLE,
    });

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(bookingRepository.cancelPendingBookingForReconciliation).not.toHaveBeenCalled();
    expect(bookingRepository.findBookingSeatsByBookingId).not.toHaveBeenCalled();
    expect(screeningRepository.releaseBookedSeats).not.toHaveBeenCalled();
    expect(reconcilePaymentRepository.createOpen).not.toHaveBeenCalled();
  });

  it("rolls the recovery back when the booking cannot be cancelled", async () => {
    paymentRepository.recoverAuthorizingPaymentPastDeadline.mockResolvedValue({
      count: 1,
      bookingId: BOOKING_ID,
      userId: USER_ID,
    });
    bookingRepository.cancelPendingBookingForReconciliation.mockResolvedValue({ count: 0 });

    await expect(service.execute(PAYMENT_ID)).rejects.toThrow(InternalServerErrorException);

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(bookingRepository.findBookingSeatsByBookingId).not.toHaveBeenCalled();
    expect(screeningRepository.releaseBookedSeats).not.toHaveBeenCalled();
    expect(reconcilePaymentRepository.createOpen).not.toHaveBeenCalled();
  });

  it("rolls the recovery back when a booked seat cannot be released", async () => {
    paymentRepository.recoverAuthorizingPaymentPastDeadline.mockResolvedValue({
      count: 1,
      bookingId: BOOKING_ID,
      userId: USER_ID,
    });
    bookingRepository.cancelPendingBookingForReconciliation.mockResolvedValue({ count: 1 });
    bookingRepository.findBookingSeatsByBookingId.mockResolvedValue(
      SCREENING_SEAT_IDS.map((screeningSeatId) => ({ screeningSeatId })),
    );
    screeningRepository.releaseBookedSeats.mockResolvedValue({ count: 1 });

    await expect(service.execute(PAYMENT_ID)).rejects.toThrow(InternalServerErrorException);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(reconcilePaymentRepository.createOpen).not.toHaveBeenCalled();
  });
});
