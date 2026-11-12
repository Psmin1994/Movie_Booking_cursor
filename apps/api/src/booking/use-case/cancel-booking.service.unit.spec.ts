/**
 * Test Intent:
 * 확정 취소는 PAID Payment가 있는 CONFIRMED Booking만 취소하고, 점유 좌석이 풀리며 PENDING Refund가 같은 전이에서 생김을 보장한다.
 * Transaction 커밋 이후 ProcessRefund Worker를 비동기로 시작하며, Worker 예외는 취소 성공을 바꾸지 않는다.
 * 결제 전 취소는 보유 시간이 남은 PENDING Booking만 취소한다. Payment가 있으면 CANCELED가 된 뒤 Booking이 CANCELLED가 되고 점유 좌석이 같은 전이에서 풀린다.
 * cancel-pending은 Refund Worker를 실행하지 않는다.
 * 없거나 취소할 수 없거나 갱신·좌석 해제가 맞지 않으면 해당 취소는 확정되지 않는다.
 */

import { jest } from "@jest/globals";
import { Prisma } from "@movie-booking/database-prisma";
import {
  ConflictException,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PrismaService } from "../../database/prisma.service.js";
import { PAYMENT_CANCELED_STATUS, PAYMENT_PENDING_STATUS } from "../../payment/payment.constants.js";
import { PROCESS_REFUND_RESULT } from "../../refund/refund.constants.js";
import { RefundRepository } from "../../refund/repository/refund.repository.js";
import { ProcessRefundService } from "../../refund/use-case/process-refund.service.js";
import { ScreeningRepository } from "../../screening/repository/screening.repository.js";
import {
  BOOKING_CONFIRMED_STATUS,
  BOOKING_PENDING_STATUS,
  CANCEL_CONFIRMED_BOOKING_RESULT,
} from "../booking.constants.js";
import { BookingRepository, type BookingForPendingCancel } from "../repository/booking.repository.js";
import { BookingSeatReleaseService } from "./booking-seat-release.service.js";
import { CancelBookingService } from "./cancel-booking.service.js";

const USER_ID = "550e8400-e29b-41d4-a716-446655440000";
const BOOKING_ID = "550e8400-e29b-41d4-a716-446655440020";
const PAYMENT_ID = "550e8400-e29b-41d4-a716-446655440030";
const PAYMENT_AMOUNT = 20_000;
const SCREENING_SEAT_IDS = [
  "550e8400-e29b-41d4-a716-446655440010",
  "550e8400-e29b-41d4-a716-446655440011",
];
const USER = { id: USER_ID, email: "user@example.com" };
const TX = { name: "transaction-client" } as unknown as Prisma.TransactionClient;

type BookingRepositoryMocks = {
  [K in "cancelConfirmedBooking" | "findBookingSeatsByBookingId"]: jest.MockedFunction<BookingRepository[K]>;
};

type RefundRepositoryMocks = {
  createPendingRefund: jest.MockedFunction<RefundRepository["createPendingRefund"]>;
};

type ScreeningRepositoryMocks = {
  releaseBookedSeats: jest.MockedFunction<ScreeningRepository["releaseBookedSeats"]>;
};

type ProcessRefundServiceMocks = {
  execute: jest.MockedFunction<ProcessRefundService["execute"]>;
};

type RunTransaction = (
  callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
) => Promise<unknown>;

const PENDING_REFUND = {
  id: "refund-1",
  paymentId: PAYMENT_ID,
  amount: PAYMENT_AMOUNT,
  status: "PENDING",
  idempotencyKey: "idem-1",
  paymentKey: "pay-key",
  cancelReason: "예매 취소",
} as const;

describe("CancelBookingService.cancelConfirmed", () => {
  let service: CancelBookingService;
  let bookingRepository: BookingRepositoryMocks;
  let screeningRepository: ScreeningRepositoryMocks;
  let refundRepository: RefundRepositoryMocks;
  let processRefundService: ProcessRefundServiceMocks;
  let transaction: jest.MockedFunction<RunTransaction>;
  let loggerError: jest.SpiedFunction<Logger["error"]>;

  beforeEach(async () => {
    bookingRepository = {
      cancelConfirmedBooking: jest.fn<BookingRepository["cancelConfirmedBooking"]>(),
      findBookingSeatsByBookingId: jest.fn<BookingRepository["findBookingSeatsByBookingId"]>(),
    };
    screeningRepository = {
      releaseBookedSeats: jest.fn<ScreeningRepository["releaseBookedSeats"]>(),
    };
    refundRepository = {
      createPendingRefund: jest.fn<RefundRepository["createPendingRefund"]>(),
    };
    processRefundService = {
      execute: jest.fn<ProcessRefundService["execute"]>().mockResolvedValue({
        result: PROCESS_REFUND_RESULT.COMPLETED,
      }),
    };
    transaction = jest.fn<RunTransaction>(async (callback) => callback(TX));
    loggerError = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);

    const moduleRef = await Test.createTestingModule({
      providers: [
        BookingSeatReleaseService,
        CancelBookingService,
        {
          provide: PrismaService,
          useValue: {
            client: {
              $transaction: transaction,
            },
          },
        },
        {
          provide: BookingRepository,
          useValue: bookingRepository,
        },
        {
          provide: ScreeningRepository,
          useValue: screeningRepository,
        },
        {
          provide: RefundRepository,
          useValue: refundRepository,
        },
        {
          provide: ProcessRefundService,
          useValue: processRefundService,
        },
      ],
    }).compile();

    service = moduleRef.get(CancelBookingService);
  });

  afterEach(() => {
    loggerError.mockRestore();
  });

  it("cancels a confirmed booking and releases booked seats", async () => {
    bookingRepository.cancelConfirmedBooking.mockResolvedValue({
      result: CANCEL_CONFIRMED_BOOKING_RESULT.CANCELLED,
      paymentId: PAYMENT_ID,
      amount: PAYMENT_AMOUNT,
    });
    bookingRepository.findBookingSeatsByBookingId.mockResolvedValue(
      SCREENING_SEAT_IDS.map((screeningSeatId) => ({ screeningSeatId })),
    );
    screeningRepository.releaseBookedSeats.mockResolvedValue({
      count: SCREENING_SEAT_IDS.length,
    });
    refundRepository.createPendingRefund.mockResolvedValue({ ...PENDING_REFUND });

    await expect(service.cancelConfirmed(USER, BOOKING_ID)).resolves.toBeUndefined();

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(bookingRepository.cancelConfirmedBooking).toHaveBeenCalledWith(
      TX,
      BOOKING_ID,
      USER.id,
    );
    expect(bookingRepository.findBookingSeatsByBookingId).toHaveBeenCalledWith(
      TX,
      BOOKING_ID,
    );
    expect(screeningRepository.releaseBookedSeats).toHaveBeenCalledWith(
      TX,
      SCREENING_SEAT_IDS,
    );
    expect(refundRepository.createPendingRefund).toHaveBeenCalledWith(
      TX,
      PAYMENT_ID,
      PAYMENT_AMOUNT,
    );
    expect(bookingRepository.cancelConfirmedBooking.mock.invocationCallOrder[0]).toBeLessThan(
      screeningRepository.releaseBookedSeats.mock.invocationCallOrder[0] ?? 0,
    );
    expect(screeningRepository.releaseBookedSeats.mock.invocationCallOrder[0]).toBeLessThan(
      refundRepository.createPendingRefund.mock.invocationCallOrder[0] ?? 0,
    );
    expect(processRefundService.execute).toHaveBeenCalledWith(PENDING_REFUND.id);
  });

  it("starts the refund worker only after the cancel transaction commits", async () => {
    let resolveTransaction!: (value: unknown) => void;
    const transactionGate = new Promise<unknown>((resolve) => {
      resolveTransaction = resolve;
    });
    let transactionCallbackStarted = false;

    transaction.mockImplementation(async (callback) => {
      transactionCallbackStarted = true;
      const result = await callback(TX);
      await transactionGate;
      return result;
    });

    bookingRepository.cancelConfirmedBooking.mockResolvedValue({
      result: CANCEL_CONFIRMED_BOOKING_RESULT.CANCELLED,
      paymentId: PAYMENT_ID,
      amount: PAYMENT_AMOUNT,
    });
    bookingRepository.findBookingSeatsByBookingId.mockResolvedValue([]);
    refundRepository.createPendingRefund.mockResolvedValue({ ...PENDING_REFUND });

    const cancelPromise = service.cancelConfirmed(USER, BOOKING_ID);

    await Promise.resolve();
    expect(transactionCallbackStarted).toBe(true);
    expect(processRefundService.execute).not.toHaveBeenCalled();

    resolveTransaction(undefined);
    await expect(cancelPromise).resolves.toBeUndefined();
    expect(processRefundService.execute).toHaveBeenCalledWith(PENDING_REFUND.id);
  });

  it("returns before the refund worker finishes", async () => {
    let resolveWorker!: (value: { result: typeof PROCESS_REFUND_RESULT.COMPLETED }) => void;
    processRefundService.execute.mockReturnValue(
      new Promise((resolve) => {
        resolveWorker = resolve;
      }),
    );

    bookingRepository.cancelConfirmedBooking.mockResolvedValue({
      result: CANCEL_CONFIRMED_BOOKING_RESULT.CANCELLED,
      paymentId: PAYMENT_ID,
      amount: PAYMENT_AMOUNT,
    });
    bookingRepository.findBookingSeatsByBookingId.mockResolvedValue([]);
    refundRepository.createPendingRefund.mockResolvedValue({ ...PENDING_REFUND });

    await expect(service.cancelConfirmed(USER, BOOKING_ID)).resolves.toBeUndefined();
    expect(processRefundService.execute).toHaveBeenCalledWith(PENDING_REFUND.id);

    resolveWorker({ result: PROCESS_REFUND_RESULT.COMPLETED });
    await Promise.resolve();
  });

  it("keeps cancel success when the refund worker rejects", async () => {
    const workerError = new Error("worker failed");
    processRefundService.execute.mockRejectedValue(workerError);

    bookingRepository.cancelConfirmedBooking.mockResolvedValue({
      result: CANCEL_CONFIRMED_BOOKING_RESULT.CANCELLED,
      paymentId: PAYMENT_ID,
      amount: PAYMENT_AMOUNT,
    });
    bookingRepository.findBookingSeatsByBookingId.mockResolvedValue([]);
    refundRepository.createPendingRefund.mockResolvedValue({ ...PENDING_REFUND });

    await expect(service.cancelConfirmed(USER, BOOKING_ID)).resolves.toBeUndefined();
    await Promise.resolve();

    expect(loggerError).toHaveBeenCalledWith(
      `Failed to process refund ${PENDING_REFUND.id}`,
      workerError.stack,
    );
  });

  it("does not log an error when the refund worker returns NOT_CLAIMED", async () => {
    processRefundService.execute.mockResolvedValue({
      result: PROCESS_REFUND_RESULT.NOT_CLAIMED,
    });

    bookingRepository.cancelConfirmedBooking.mockResolvedValue({
      result: CANCEL_CONFIRMED_BOOKING_RESULT.CANCELLED,
      paymentId: PAYMENT_ID,
      amount: PAYMENT_AMOUNT,
    });
    bookingRepository.findBookingSeatsByBookingId.mockResolvedValue([]);
    refundRepository.createPendingRefund.mockResolvedValue({ ...PENDING_REFUND });

    await expect(service.cancelConfirmed(USER, BOOKING_ID)).resolves.toBeUndefined();
    await Promise.resolve();

    expect(loggerError).not.toHaveBeenCalled();
  });

  it("throws when the booking is not found", async () => {
    bookingRepository.cancelConfirmedBooking.mockResolvedValue({
      result: CANCEL_CONFIRMED_BOOKING_RESULT.NOT_FOUND,
    });

    await expect(service.cancelConfirmed(USER, BOOKING_ID)).rejects.toThrow(
      NotFoundException,
    );

    expect(bookingRepository.findBookingSeatsByBookingId).not.toHaveBeenCalled();
    expect(screeningRepository.releaseBookedSeats).not.toHaveBeenCalled();
    expect(refundRepository.createPendingRefund).not.toHaveBeenCalled();
  });

  it.each([
    CANCEL_CONFIRMED_BOOKING_RESULT.NOT_CANCELLABLE,
    CANCEL_CONFIRMED_BOOKING_RESULT.PAYMENT_NOT_PAID,
  ])("throws when the booking cannot be cancelled (%s)", async (result) => {
    bookingRepository.cancelConfirmedBooking.mockResolvedValue({ result });

    await expect(service.cancelConfirmed(USER, BOOKING_ID)).rejects.toThrow(
      new ConflictException("취소할 수 없는 예매입니다."),
    );

    expect(screeningRepository.releaseBookedSeats).not.toHaveBeenCalled();
    expect(refundRepository.createPendingRefund).not.toHaveBeenCalled();
  });

  it("throws when the booking is already cancelled", async () => {
    bookingRepository.cancelConfirmedBooking.mockResolvedValue({
      result: CANCEL_CONFIRMED_BOOKING_RESULT.ALREADY_CANCELLED,
    });

    await expect(service.cancelConfirmed(USER, BOOKING_ID)).rejects.toThrow(
      ConflictException,
    );

    expect(bookingRepository.findBookingSeatsByBookingId).not.toHaveBeenCalled();
    expect(screeningRepository.releaseBookedSeats).not.toHaveBeenCalled();
  });

  it("throws when released seat count does not match the booking seat count", async () => {
    bookingRepository.cancelConfirmedBooking.mockResolvedValue({
      result: CANCEL_CONFIRMED_BOOKING_RESULT.CANCELLED,
      paymentId: PAYMENT_ID,
      amount: PAYMENT_AMOUNT,
    });
    bookingRepository.findBookingSeatsByBookingId.mockResolvedValue(
      SCREENING_SEAT_IDS.map((screeningSeatId) => ({ screeningSeatId })),
    );
    screeningRepository.releaseBookedSeats.mockResolvedValue({ count: 1 });

    await expect(service.cancelConfirmed(USER, BOOKING_ID)).rejects.toThrow(
      InternalServerErrorException,
    );

    expect(screeningRepository.releaseBookedSeats).toHaveBeenCalledWith(
      TX,
      SCREENING_SEAT_IDS,
    );
    expect(refundRepository.createPendingRefund).not.toHaveBeenCalled();
    await expect(transaction.mock.results[0]?.value).rejects.toThrow(
      InternalServerErrorException,
    );
  });

  it("rolls back when creating the refund fails", async () => {
    bookingRepository.cancelConfirmedBooking.mockResolvedValue({
      result: CANCEL_CONFIRMED_BOOKING_RESULT.CANCELLED,
      paymentId: PAYMENT_ID,
      amount: PAYMENT_AMOUNT,
    });
    bookingRepository.findBookingSeatsByBookingId.mockResolvedValue(
      SCREENING_SEAT_IDS.map((screeningSeatId) => ({ screeningSeatId })),
    );
    screeningRepository.releaseBookedSeats.mockResolvedValue({
      count: SCREENING_SEAT_IDS.length,
    });
    refundRepository.createPendingRefund.mockRejectedValue(
      new Error("refund failed"),
    );

    await expect(service.cancelConfirmed(USER, BOOKING_ID)).rejects.toThrow(
      "refund failed",
    );
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(bookingRepository.cancelConfirmedBooking).toHaveBeenCalledWith(TX, BOOKING_ID, USER.id);
    expect(screeningRepository.releaseBookedSeats).toHaveBeenCalledWith(TX, SCREENING_SEAT_IDS);
    expect(refundRepository.createPendingRefund).toHaveBeenCalledWith(TX, PAYMENT_ID, PAYMENT_AMOUNT);
    await expect(transaction.mock.results[0]?.value).rejects.toThrow(
      "refund failed",
    );
  });

  it("does not release seats when the booking has no booking seats", async () => {
    bookingRepository.cancelConfirmedBooking.mockResolvedValue({
      result: CANCEL_CONFIRMED_BOOKING_RESULT.CANCELLED,
      paymentId: PAYMENT_ID,
      amount: PAYMENT_AMOUNT,
    });
    bookingRepository.findBookingSeatsByBookingId.mockResolvedValue([]);
    refundRepository.createPendingRefund.mockResolvedValue({ ...PENDING_REFUND });

    await expect(service.cancelConfirmed(USER, BOOKING_ID)).resolves.toBeUndefined();

    expect(bookingRepository.findBookingSeatsByBookingId).toHaveBeenCalledWith(
      TX,
      BOOKING_ID,
    );
    expect(screeningRepository.releaseBookedSeats).not.toHaveBeenCalled();
    expect(refundRepository.createPendingRefund).toHaveBeenCalledWith(
      TX,
      PAYMENT_ID,
      PAYMENT_AMOUNT,
    );
    expect(processRefundService.execute).toHaveBeenCalledWith(PENDING_REFUND.id);
  });
});

const PENDING_NOW = new Date("2026-10-14T00:00:00.000Z");
const PENDING_FUTURE = new Date("2026-10-14T00:10:00.000Z");

type PaymentUpdateMany = (args: {
  where: { booking?: { expiresAt: { gt: Date } } };
  data: { status: string };
}) => Promise<{ count: number }>;

type PendingBookingRepositoryMocks = {
  [K in
    | "lockBookingById"
    | "findBookingForPendingCancel"
    | "cancelPendingBooking"
    | "findBookingSeatsByBookingId"]: jest.MockedFunction<BookingRepository[K]>;
};

function openBooking(payment: BookingForPendingCancel["payment"]): BookingForPendingCancel {
  return {
    status: BOOKING_PENDING_STATUS,
    expiresAt: PENDING_FUTURE,
    payment,
  };
}

describe("CancelBookingService.cancelPending", () => {
  let service: CancelBookingService;
  let bookingRepository: PendingBookingRepositoryMocks;
  let screeningRepository: ScreeningRepositoryMocks;
  let processRefundService: ProcessRefundServiceMocks;
  let paymentUpdateMany: jest.MockedFunction<PaymentUpdateMany>;
  let transaction: jest.MockedFunction<RunTransaction>;
  let tx: Prisma.TransactionClient;

  beforeEach(async () => {
    jest.spyOn(Date, "now").mockReturnValue(PENDING_NOW.getTime());
    bookingRepository = {
      lockBookingById: jest.fn<BookingRepository["lockBookingById"]>(),
      findBookingForPendingCancel: jest.fn<BookingRepository["findBookingForPendingCancel"]>(),
      cancelPendingBooking: jest.fn<BookingRepository["cancelPendingBooking"]>(),
      findBookingSeatsByBookingId: jest.fn<BookingRepository["findBookingSeatsByBookingId"]>(),
    };
    screeningRepository = {
      releaseBookedSeats: jest.fn<ScreeningRepository["releaseBookedSeats"]>(),
    };
    processRefundService = {
      execute: jest.fn<ProcessRefundService["execute"]>(),
    };
    paymentUpdateMany = jest.fn<PaymentUpdateMany>();
    tx = {
      payment: { updateMany: paymentUpdateMany },
    } as unknown as Prisma.TransactionClient;
    transaction = jest.fn<RunTransaction>(async (callback) => callback(tx));

    const moduleRef = await Test.createTestingModule({
      providers: [
        BookingSeatReleaseService,
        CancelBookingService,
        {
          provide: PrismaService,
          useValue: {
            client: {
              $transaction: transaction,
            },
          },
        },
        { provide: BookingRepository, useValue: bookingRepository },
        { provide: ScreeningRepository, useValue: screeningRepository },
        {
          provide: RefundRepository,
          useValue: { createPendingRefund: jest.fn() },
        },
        {
          provide: ProcessRefundService,
          useValue: processRefundService,
        },
      ],
    }).compile();

    service = moduleRef.get(CancelBookingService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("cancels a pending booking that has no payment and releases booked seats", async () => {
    bookingRepository.findBookingForPendingCancel.mockResolvedValue(openBooking(null));
    bookingRepository.cancelPendingBooking.mockResolvedValue({ count: 1 });
    bookingRepository.findBookingSeatsByBookingId.mockResolvedValue(
      SCREENING_SEAT_IDS.map((screeningSeatId) => ({ screeningSeatId })),
    );
    screeningRepository.releaseBookedSeats.mockResolvedValue({
      count: SCREENING_SEAT_IDS.length,
    });

    await expect(service.cancelPending(USER, BOOKING_ID)).resolves.toBeUndefined();

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(bookingRepository.lockBookingById).toHaveBeenCalledWith(tx, BOOKING_ID);
    expect(bookingRepository.findBookingForPendingCancel).toHaveBeenCalledWith(tx, BOOKING_ID, USER.id);
    expect(paymentUpdateMany).not.toHaveBeenCalled();
    expect(bookingRepository.cancelPendingBooking).toHaveBeenCalledWith(
      tx,
      BOOKING_ID,
      USER.id,
      PENDING_NOW,
      "none",
    );
    expect(bookingRepository.findBookingSeatsByBookingId).toHaveBeenCalledWith(tx, BOOKING_ID);
    expect(screeningRepository.releaseBookedSeats).toHaveBeenCalledWith(tx, SCREENING_SEAT_IDS);
    expect(bookingRepository.lockBookingById.mock.invocationCallOrder[0]).toBeLessThan(
      bookingRepository.findBookingForPendingCancel.mock.invocationCallOrder[0] ?? 0,
    );
    expect(bookingRepository.findBookingForPendingCancel.mock.invocationCallOrder[0]).toBeLessThan(
      bookingRepository.cancelPendingBooking.mock.invocationCallOrder[0] ?? 0,
    );
    expect(bookingRepository.cancelPendingBooking.mock.invocationCallOrder[0]).toBeLessThan(
      screeningRepository.releaseBookedSeats.mock.invocationCallOrder[0] ?? 0,
    );
    expect(processRefundService.execute).not.toHaveBeenCalled();
  });

  it("cancels a pending payment and then cancels the booking", async () => {
    bookingRepository.findBookingForPendingCancel.mockResolvedValue(
      openBooking({ id: PAYMENT_ID, status: PAYMENT_PENDING_STATUS }),
    );
    paymentUpdateMany.mockResolvedValue({ count: 1 });
    bookingRepository.cancelPendingBooking.mockResolvedValue({ count: 1 });
    bookingRepository.findBookingSeatsByBookingId.mockResolvedValue(
      SCREENING_SEAT_IDS.map((screeningSeatId) => ({ screeningSeatId })),
    );
    screeningRepository.releaseBookedSeats.mockResolvedValue({
      count: SCREENING_SEAT_IDS.length,
    });

    await expect(service.cancelPending(USER, BOOKING_ID)).resolves.toBeUndefined();

    expect(paymentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: PAYMENT_CANCELED_STATUS },
      }),
    );
    expect(bookingRepository.cancelPendingBooking).toHaveBeenCalledWith(
      tx,
      BOOKING_ID,
      USER.id,
      PENDING_NOW,
      "canceled",
    );
    expect(paymentUpdateMany.mock.invocationCallOrder[0]).toBeLessThan(
      bookingRepository.cancelPendingBooking.mock.invocationCallOrder[0] ?? 0,
    );
    expect(bookingRepository.cancelPendingBooking.mock.invocationCallOrder[0]).toBeLessThan(
      screeningRepository.releaseBookedSeats.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("throws when the pending booking is not found", async () => {
    bookingRepository.findBookingForPendingCancel.mockResolvedValue(null);

    await expect(service.cancelPending(USER, BOOKING_ID)).rejects.toBeInstanceOf(NotFoundException);
    expect(paymentUpdateMany).not.toHaveBeenCalled();
    expect(bookingRepository.cancelPendingBooking).not.toHaveBeenCalled();
    expect(bookingRepository.findBookingSeatsByBookingId).not.toHaveBeenCalled();
    expect(screeningRepository.releaseBookedSeats).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "expiresAt is equal to now",
      booking: { status: BOOKING_PENDING_STATUS, expiresAt: PENDING_NOW, payment: null },
    },
    {
      label: "the booking is confirmed",
      booking: { status: BOOKING_CONFIRMED_STATUS, expiresAt: PENDING_FUTURE, payment: null },
    },
    {
      label: "the payment is authorizing",
      booking: {
        status: BOOKING_PENDING_STATUS,
        expiresAt: PENDING_FUTURE,
        payment: { id: PAYMENT_ID, status: "AUTHORIZING" },
      },
    },
  ])("throws when $label", async ({ booking }) => {
    bookingRepository.findBookingForPendingCancel.mockResolvedValue(booking);

    await expect(service.cancelPending(USER, BOOKING_ID)).rejects.toBeInstanceOf(ConflictException);
    expect(paymentUpdateMany).not.toHaveBeenCalled();
    expect(bookingRepository.cancelPendingBooking).not.toHaveBeenCalled();
    expect(screeningRepository.releaseBookedSeats).not.toHaveBeenCalled();
  });

  it("does not cancel the booking when the pending payment update matches nothing", async () => {
    bookingRepository.findBookingForPendingCancel.mockResolvedValue(
      openBooking({ id: PAYMENT_ID, status: PAYMENT_PENDING_STATUS }),
    );
    paymentUpdateMany.mockResolvedValue({ count: 0 });

    await expect(service.cancelPending(USER, BOOKING_ID)).rejects.toBeInstanceOf(ConflictException);
    expect(bookingRepository.cancelPendingBooking).not.toHaveBeenCalled();
    expect(screeningRepository.releaseBookedSeats).not.toHaveBeenCalled();
  });

  it("does not release seats when the booking update is incomplete", async () => {
    bookingRepository.findBookingForPendingCancel.mockResolvedValue(
      openBooking({ id: PAYMENT_ID, status: PAYMENT_PENDING_STATUS }),
    );
    paymentUpdateMany.mockResolvedValue({ count: 1 });
    bookingRepository.cancelPendingBooking.mockResolvedValue({ count: 0 });

    await expect(service.cancelPending(USER, BOOKING_ID)).rejects.toBeInstanceOf(InternalServerErrorException);
    expect(bookingRepository.cancelPendingBooking).toHaveBeenCalledWith(
      tx,
      BOOKING_ID,
      USER.id,
      PENDING_NOW,
      "canceled",
    );
    expect(bookingRepository.findBookingSeatsByBookingId).not.toHaveBeenCalled();
    expect(screeningRepository.releaseBookedSeats).not.toHaveBeenCalled();
    await expect(transaction.mock.results[0]?.value).rejects.toBeInstanceOf(InternalServerErrorException);
  });

  it("does not confirm the pending cancel when released seat count does not match", async () => {
    bookingRepository.findBookingForPendingCancel.mockResolvedValue(openBooking(null));
    bookingRepository.cancelPendingBooking.mockResolvedValue({ count: 1 });
    bookingRepository.findBookingSeatsByBookingId.mockResolvedValue(
      SCREENING_SEAT_IDS.map((screeningSeatId) => ({ screeningSeatId })),
    );
    screeningRepository.releaseBookedSeats.mockResolvedValue({ count: 1 });

    await expect(service.cancelPending(USER, BOOKING_ID)).rejects.toBeInstanceOf(InternalServerErrorException);
    await expect(transaction.mock.results[0]?.value).rejects.toBeInstanceOf(InternalServerErrorException);
  });
});
