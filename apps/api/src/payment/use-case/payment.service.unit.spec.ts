/**
 * Test Intent:
 * PENDING Payment는 AUTHORIZING이 된 뒤에만 외부 승인 결과로 PAID, FAILED, RECONCILIATION_REQUIRED 중 하나가 됨을 보장한다. Confirm이 불명이거나 식별자가 다르면 deadline까지 Retrieve한다. 기한 전에 확정하지 못하면 Payment는 RECONCILIATION_REQUIRED, Booking은 CANCELLED가 되고 cancelledAt이 기록되며 좌석을 반환한 뒤에만 대사 행이 생긴다. 기한 이후 SUCCESS도 같은 불확실 전이다. 결제 전이에 실패하면 예매, 좌석, 대사 행을 만들지 않고, 후속 전이가 맞지 않으면 그 전이를 확정하지 않는다.
 */

import { jest } from "@jest/globals";
import { Prisma } from "@movie-booking/database-prisma";
import {
  ConflictException,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { BookingRepository } from "../../booking/repository/booking.repository.js";
import { BookingSeatReleaseService } from "../../booking/use-case/booking-seat-release.service.js";
import { PrismaService } from "../../database/prisma.service.js";
import { ScreeningRepository } from "../../screening/repository/screening.repository.js";
import { PaymentGateway } from "../gateway/payment-gateway.js";
import {
  BEGIN_AUTHORIZATION_RESULT,
  EXPIRE_PAYMENT_RESULT,
  FAIL_PAYMENT_RESULT,
  PAY_PAYMENT_RESULT,
  PAYMENT_AUTHORIZING_RETRIEVE_INTERVAL_MS,
  RECONCILE_AUTHORIZING_PAYMENT_RESULT,
} from "../payment.constants.js";
import { PaymentRepository } from "../repository/payment.repository.js";
import { ReconcilePaymentRepository } from "../repository/reconcile-payment.repository.js";
import { PaymentService } from "./payment.service.js";

const USER_ID = "550e8400-e29b-41d4-a716-446655440000";
const PAYMENT_ID = "550e8400-e29b-41d4-a716-446655440030";
const BOOKING_ID = "550e8400-e29b-41d4-a716-446655440020";
const ORDER_ID = "ord_550e8400-e29b-41d4-a716-446655440031";
const PAYMENT_KEY = "pay-key";
const AMOUNT = 20_000;
const PAID_AT = new Date("2026-09-24T10:30:00.000Z");
const FAILED_AT = new Date("2026-09-24T10:30:00.000Z");
const SCREENING_SEAT_IDS = [
  "550e8400-e29b-41d4-a716-446655440010",
  "550e8400-e29b-41d4-a716-446655440011",
];
const USER = { id: USER_ID, email: "user@example.com" };

function openAuthorization() {
  return {
    result: BEGIN_AUTHORIZATION_RESULT.AUTHORIZING,
    authorizationExpiresAt: new Date(Date.now() + 60_000),
  };
}

function closedAuthorization() {
  return {
    result: BEGIN_AUTHORIZATION_RESULT.AUTHORIZING,
    authorizationExpiresAt: new Date(Date.now() - 1_000),
  };
}
const TX = { name: "transaction-client" } as unknown as Prisma.TransactionClient;
const PENDING_PAYMENT = {
  bookingId: BOOKING_ID,
  orderId: ORDER_ID,
  amount: AMOUNT,
  paymentKey: null,
  status: "PENDING",
  bookingStatus: "PENDING",
  authorizationExpiresAt: null,
  paidAt: null,
  failedAt: null,
};
type RunTransaction = (
  callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
) => Promise<unknown>;

describe("PaymentService", () => {
  let service: PaymentService;
  let paymentRepository: {
    findOwnedPayment: jest.MockedFunction<PaymentRepository["findOwnedPayment"]>;
    beginAuthorization: jest.MockedFunction<PaymentRepository["beginAuthorization"]>;
    expirePendingPayment: jest.MockedFunction<PaymentRepository["expirePendingPayment"]>;
    payAuthorizingPayment: jest.MockedFunction<PaymentRepository["payAuthorizingPayment"]>;
    failAuthorizingPayment: jest.MockedFunction<PaymentRepository["failAuthorizingPayment"]>;
    reconcileAuthorizingPayment: jest.MockedFunction<PaymentRepository["reconcileAuthorizingPayment"]>;
  };
  let bookingRepository: {
    findBookingSeatsByBookingId: jest.MockedFunction<BookingRepository["findBookingSeatsByBookingId"]>;
    expirePendingBooking: jest.MockedFunction<BookingRepository["expirePendingBooking"]>;
    cancelPendingBookingForReconciliation: jest.MockedFunction<
      BookingRepository["cancelPendingBookingForReconciliation"]
    >;
    confirmPendingBooking: jest.MockedFunction<BookingRepository["confirmPendingBooking"]>;
    failPendingBooking: jest.MockedFunction<BookingRepository["failPendingBooking"]>;
  };
  let screeningRepository: {
    releaseBookedSeats: jest.MockedFunction<ScreeningRepository["releaseBookedSeats"]>;
  };
  let reconcilePaymentRepository: {
    createOpen: jest.MockedFunction<ReconcilePaymentRepository["createOpen"]>;
  };
  let paymentGateway: {
    confirm: jest.MockedFunction<PaymentGateway["confirm"]>;
    retrieve: jest.MockedFunction<PaymentGateway["retrieve"]>;
  };
  let transaction: jest.MockedFunction<RunTransaction>;

  beforeEach(async () => {
    paymentRepository = {
      findOwnedPayment: jest.fn<PaymentRepository["findOwnedPayment"]>(),
      beginAuthorization: jest.fn<PaymentRepository["beginAuthorization"]>(),
      expirePendingPayment: jest.fn<PaymentRepository["expirePendingPayment"]>(),
      payAuthorizingPayment: jest.fn<PaymentRepository["payAuthorizingPayment"]>(),
      failAuthorizingPayment: jest.fn<PaymentRepository["failAuthorizingPayment"]>(),
      reconcileAuthorizingPayment: jest.fn<PaymentRepository["reconcileAuthorizingPayment"]>(),
    };
    bookingRepository = {
      findBookingSeatsByBookingId: jest.fn<BookingRepository["findBookingSeatsByBookingId"]>(),
      expirePendingBooking: jest.fn<BookingRepository["expirePendingBooking"]>(),
      cancelPendingBookingForReconciliation:
        jest.fn<BookingRepository["cancelPendingBookingForReconciliation"]>(),
      confirmPendingBooking: jest.fn<BookingRepository["confirmPendingBooking"]>(),
      failPendingBooking: jest.fn<BookingRepository["failPendingBooking"]>(),
    };
    bookingRepository.expirePendingBooking.mockResolvedValue({ count: 1 });
    bookingRepository.cancelPendingBookingForReconciliation.mockResolvedValue({ count: 1 });
    bookingRepository.confirmPendingBooking.mockResolvedValue({ count: 1 });
    bookingRepository.failPendingBooking.mockResolvedValue({ count: 1 });
    screeningRepository = {
      releaseBookedSeats: jest.fn<ScreeningRepository["releaseBookedSeats"]>(),
    };
    reconcilePaymentRepository = {
      createOpen: jest.fn<ReconcilePaymentRepository["createOpen"]>(),
    };
    reconcilePaymentRepository.createOpen.mockResolvedValue({
      id: "reconciliation-1",
      paymentId: PAYMENT_ID,
      createdAt: new Date("2026-10-14T00:00:00.000Z"),
      nextProcessAt: new Date("2026-10-14T00:00:00.000Z"),
    });
    paymentGateway = {
      confirm: jest.fn<PaymentGateway["confirm"]>(),
      retrieve: jest.fn<PaymentGateway["retrieve"]>(),
    };
    transaction = jest.fn<RunTransaction>(async (callback) => callback(TX));

    const moduleRef = await Test.createTestingModule({
      providers: [
        BookingSeatReleaseService,
        PaymentService,
        {
          provide: PrismaService,
          useValue: { client: { $transaction: transaction } },
        },
        { provide: PaymentRepository, useValue: paymentRepository },
        { provide: BookingRepository, useValue: bookingRepository },
        { provide: ScreeningRepository, useValue: screeningRepository },
        { provide: ReconcilePaymentRepository, useValue: reconcilePaymentRepository },
        { provide: PaymentGateway, useValue: paymentGateway },
      ],
    }).compile();

    service = moduleRef.get(PaymentService);
    paymentRepository.beginAuthorization.mockResolvedValue(openAuthorization());
    paymentRepository.reconcileAuthorizingPayment.mockResolvedValue({
      result: RECONCILE_AUTHORIZING_PAYMENT_RESULT.RECONCILIATION_REQUIRED,
    });
  });

  it("moves a pending payment to authorizing before the gateway approves it", async () => {
    const order: string[] = [];
    paymentRepository.findOwnedPayment.mockResolvedValue(PENDING_PAYMENT);
    paymentRepository.beginAuthorization.mockImplementation(async () => {
      order.push("authorize");
      return openAuthorization();
    });
    paymentGateway.confirm.mockImplementation(async () => {
      order.push("confirm");
      expect(paymentRepository.payAuthorizingPayment).not.toHaveBeenCalled();
      return {
        status: "SUCCESS",
        paymentKey: PAYMENT_KEY,
        orderId: ORDER_ID,
        amount: AMOUNT,
        approvedAt: PAID_AT,
      };
    });
    paymentRepository.payAuthorizingPayment.mockImplementation(async () => {
      order.push("paid");
      return {
        result: PAY_PAYMENT_RESULT.PAID,
        payment: {
          id: PAYMENT_ID,
          bookingId: BOOKING_ID,
          status: "PAID",
          amount: AMOUNT,
          paidAt: PAID_AT,
        },
      };
    });
    bookingRepository.confirmPendingBooking.mockImplementation(() => {
      order.push("booking");
      return Promise.resolve({ count: 1 }) as ReturnType<BookingRepository["confirmPendingBooking"]>;
    });

    await expect(service.pay(USER, PAYMENT_ID, PAYMENT_KEY)).resolves.toEqual({
      id: PAYMENT_ID,
      bookingId: BOOKING_ID,
      status: "PAID",
      paidAt: PAID_AT.toISOString(),
    });
    expect(order).toEqual(["authorize", "confirm", "paid", "booking"]);
    expect(paymentRepository.findOwnedPayment).toHaveBeenCalledWith(PAYMENT_ID, USER.id);
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(paymentRepository.beginAuthorization).toHaveBeenCalledWith(
      TX,
      PAYMENT_ID,
      USER.id,
      PAYMENT_KEY,
      expect.any(Date),
    );
    expect(paymentGateway.confirm).toHaveBeenCalledWith({
      paymentKey: PAYMENT_KEY,
      orderId: ORDER_ID,
      amount: AMOUNT,
    });
    expect(paymentRepository.payAuthorizingPayment).toHaveBeenCalledWith(
      TX,
      PAYMENT_ID,
      USER.id,
      PAYMENT_KEY,
      expect.any(Date),
    );
    expect(bookingRepository.confirmPendingBooking).toHaveBeenCalledWith(
      TX,
      BOOKING_ID,
      USER.id,
      PAID_AT,
    );
    expect(paymentRepository.payAuthorizingPayment.mock.invocationCallOrder[0]).toBeLessThan(
      bookingRepository.confirmPendingBooking.mock.invocationCallOrder[0] ?? 0,
    );
    expect(paymentRepository.expirePendingPayment).not.toHaveBeenCalled();
    expect(paymentRepository.failAuthorizingPayment).not.toHaveBeenCalled();
    expect(bookingRepository.failPendingBooking).not.toHaveBeenCalled();
  });

  it.each([
    ["amount", { paymentKey: PAYMENT_KEY, orderId: ORDER_ID, amount: AMOUNT + 1 }],
    ["orderId", { paymentKey: PAYMENT_KEY, orderId: "ord_other", amount: AMOUNT }],
    ["paymentKey", { paymentKey: "other-key", orderId: ORDER_ID, amount: AMOUNT }],
  ])(
    "requires reconciliation when confirm %s does not match after the deadline",
    async (_field, mismatch) => {
      paymentRepository.findOwnedPayment.mockResolvedValue(PENDING_PAYMENT);
      paymentRepository.beginAuthorization.mockResolvedValue(closedAuthorization());
      paymentGateway.confirm.mockResolvedValue({
        status: "SUCCESS",
        approvedAt: PAID_AT,
        ...mismatch,
      });
      bookingRepository.findBookingSeatsByBookingId.mockResolvedValue(
        SCREENING_SEAT_IDS.map((screeningSeatId) => ({ screeningSeatId })),
      );
      screeningRepository.releaseBookedSeats.mockResolvedValue({
        count: SCREENING_SEAT_IDS.length,
      });

      await expect(service.pay(USER, PAYMENT_ID, PAYMENT_KEY)).resolves.toEqual({
        id: PAYMENT_ID,
        bookingId: BOOKING_ID,
        status: "RECONCILIATION_REQUIRED",
      });
      expect(paymentGateway.retrieve).not.toHaveBeenCalled();
      expect(paymentRepository.payAuthorizingPayment).not.toHaveBeenCalled();
      expect(paymentRepository.failAuthorizingPayment).not.toHaveBeenCalled();
      expect(paymentRepository.reconcileAuthorizingPayment).toHaveBeenCalledWith(
        TX,
        PAYMENT_ID,
        USER.id,
        expect.any(Date),
      );
    },
  );

  it("rejects pay when the payment is missing", async () => {
    paymentRepository.findOwnedPayment.mockResolvedValue(null);

    await expect(service.pay(USER, PAYMENT_ID, PAYMENT_KEY)).rejects.toThrow(
      NotFoundException,
    );
    expect(transaction).not.toHaveBeenCalled();
    expect(paymentGateway.confirm).not.toHaveBeenCalled();
  });

  it("rejects pay when the payment is already processed", async () => {
    paymentRepository.findOwnedPayment.mockResolvedValue({
      ...PENDING_PAYMENT,
      status: "PAID",
    });

    await expect(service.pay(USER, PAYMENT_ID, PAYMENT_KEY)).rejects.toThrow(
      ConflictException,
    );
    expect(transaction).not.toHaveBeenCalled();
    expect(paymentGateway.confirm).not.toHaveBeenCalled();
    expect(paymentRepository.beginAuthorization).not.toHaveBeenCalled();
  });

  it("rejects pay when the payment is already expired", async () => {
    paymentRepository.findOwnedPayment.mockResolvedValue({
      ...PENDING_PAYMENT,
      status: "EXPIRED",
    });

    await expect(service.pay(USER, PAYMENT_ID, PAYMENT_KEY)).rejects.toThrow(
      "결제 가능 시간이 만료되었습니다.",
    );
    expect(transaction).not.toHaveBeenCalled();
    expect(paymentGateway.confirm).not.toHaveBeenCalled();
  });

  it("expires a pending payment whose booking hold has ended and does not confirm it", async () => {
    paymentRepository.findOwnedPayment.mockResolvedValue(PENDING_PAYMENT);
    paymentRepository.beginAuthorization.mockResolvedValue({
      result: BEGIN_AUTHORIZATION_RESULT.NOT_ELIGIBLE,
    });
    paymentRepository.expirePendingPayment.mockResolvedValue({
      result: EXPIRE_PAYMENT_RESULT.EXPIRED,
      payment: {
        id: PAYMENT_ID,
        bookingId: BOOKING_ID,
        status: "EXPIRED",
      },
    });
    bookingRepository.findBookingSeatsByBookingId.mockResolvedValue(
      SCREENING_SEAT_IDS.map((screeningSeatId) => ({ screeningSeatId })),
    );
    screeningRepository.releaseBookedSeats.mockResolvedValue({
      count: SCREENING_SEAT_IDS.length,
    });

    await expect(service.pay(USER, PAYMENT_ID, PAYMENT_KEY)).rejects.toThrow(
      "결제 가능 시간이 만료되었습니다.",
    );
    expect(paymentGateway.confirm).not.toHaveBeenCalled();
    expect(paymentRepository.payAuthorizingPayment).not.toHaveBeenCalled();
    expect(paymentRepository.expirePendingPayment).toHaveBeenCalledWith(
      TX,
      PAYMENT_ID,
      USER.id,
      paymentRepository.beginAuthorization.mock.calls[0]?.[4],
    );
    expect(bookingRepository.expirePendingBooking).toHaveBeenCalledWith(
      TX,
      BOOKING_ID,
      USER.id,
      paymentRepository.beginAuthorization.mock.calls[0]?.[4],
    );
    expect(paymentRepository.expirePendingPayment.mock.invocationCallOrder[0]).toBeLessThan(
      bookingRepository.expirePendingBooking.mock.invocationCallOrder[0] ?? 0,
    );
    expect(bookingRepository.expirePendingBooking.mock.invocationCallOrder[0]).toBeLessThan(
      screeningRepository.releaseBookedSeats.mock.invocationCallOrder[0] ?? 0,
    );
    expect(screeningRepository.releaseBookedSeats).toHaveBeenCalledWith(TX, SCREENING_SEAT_IDS);
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it("does not release seats when the pending payment cannot be expired", async () => {
    paymentRepository.findOwnedPayment.mockResolvedValue(PENDING_PAYMENT);
    paymentRepository.beginAuthorization.mockResolvedValue({
      result: BEGIN_AUTHORIZATION_RESULT.NOT_ELIGIBLE,
    });
    paymentRepository.expirePendingPayment.mockResolvedValue({
      result: EXPIRE_PAYMENT_RESULT.NOT_EXPIRED,
    });

    await expect(service.pay(USER, PAYMENT_ID, PAYMENT_KEY)).rejects.toThrow(
      "결제할 수 없는 상태입니다.",
    );
    expect(paymentGateway.confirm).not.toHaveBeenCalled();
    expect(bookingRepository.expirePendingBooking).not.toHaveBeenCalled();
    expect(bookingRepository.findBookingSeatsByBookingId).not.toHaveBeenCalled();
    expect(screeningRepository.releaseBookedSeats).not.toHaveBeenCalled();
  });

  it("rolls the expiration back when a booked seat cannot be released", async () => {
    paymentRepository.findOwnedPayment.mockResolvedValue(PENDING_PAYMENT);
    paymentRepository.beginAuthorization.mockResolvedValue({
      result: BEGIN_AUTHORIZATION_RESULT.NOT_ELIGIBLE,
    });
    paymentRepository.expirePendingPayment.mockResolvedValue({
      result: EXPIRE_PAYMENT_RESULT.EXPIRED,
      payment: {
        id: PAYMENT_ID,
        bookingId: BOOKING_ID,
        status: "EXPIRED",
      },
    });
    bookingRepository.findBookingSeatsByBookingId.mockResolvedValue(
      SCREENING_SEAT_IDS.map((screeningSeatId) => ({ screeningSeatId })),
    );
    screeningRepository.releaseBookedSeats.mockResolvedValue({ count: 1 });

    await expect(service.pay(USER, PAYMENT_ID, PAYMENT_KEY)).rejects.toThrow(
      InternalServerErrorException,
    );
    expect(paymentGateway.confirm).not.toHaveBeenCalled();
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it("rolls the expiration back when the booking cannot be expired", async () => {
    paymentRepository.findOwnedPayment.mockResolvedValue(PENDING_PAYMENT);
    paymentRepository.beginAuthorization.mockResolvedValue({
      result: BEGIN_AUTHORIZATION_RESULT.NOT_ELIGIBLE,
    });
    paymentRepository.expirePendingPayment.mockResolvedValue({
      result: EXPIRE_PAYMENT_RESULT.EXPIRED,
      payment: {
        id: PAYMENT_ID,
        bookingId: BOOKING_ID,
        status: "EXPIRED",
      },
    });
    bookingRepository.expirePendingBooking.mockResolvedValue({ count: 0 });

    await expect(service.pay(USER, PAYMENT_ID, PAYMENT_KEY)).rejects.toThrow(
      InternalServerErrorException,
    );
    expect(paymentGateway.confirm).not.toHaveBeenCalled();
    expect(bookingRepository.findBookingSeatsByBookingId).not.toHaveBeenCalled();
    expect(screeningRepository.releaseBookedSeats).not.toHaveBeenCalled();
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it("rolls back pay when the booking cannot be confirmed", async () => {
    paymentRepository.findOwnedPayment.mockResolvedValue(PENDING_PAYMENT);
    paymentGateway.confirm.mockResolvedValue({
      status: "SUCCESS",
      paymentKey: PAYMENT_KEY,
      orderId: ORDER_ID,
      amount: AMOUNT,
      approvedAt: PAID_AT,
    });
    paymentRepository.payAuthorizingPayment.mockResolvedValue({
      result: PAY_PAYMENT_RESULT.PAID,
      payment: {
        id: PAYMENT_ID,
        bookingId: BOOKING_ID,
        status: "PAID",
        amount: AMOUNT,
        paidAt: PAID_AT,
      },
    });
    bookingRepository.confirmPendingBooking.mockResolvedValue({ count: 0 });

    await expect(service.pay(USER, PAYMENT_ID, PAYMENT_KEY)).rejects.toThrow(
      InternalServerErrorException,
    );
    expect(bookingRepository.confirmPendingBooking).toHaveBeenCalledWith(
      TX,
      BOOKING_ID,
      USER.id,
      PAID_AT,
    );
    expect(screeningRepository.releaseBookedSeats).not.toHaveBeenCalled();
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it("fails an authorizing payment and releases seats when the gateway declines", async () => {
    paymentRepository.findOwnedPayment.mockResolvedValue(PENDING_PAYMENT);
    paymentGateway.confirm.mockImplementation(async () => {
      expect(paymentRepository.failAuthorizingPayment).not.toHaveBeenCalled();
      expect(bookingRepository.failPendingBooking).not.toHaveBeenCalled();
      return {
        status: "FAILED",
      };
    });
    paymentRepository.failAuthorizingPayment.mockResolvedValue({
      result: FAIL_PAYMENT_RESULT.FAILED,
      payment: {
        id: PAYMENT_ID,
        bookingId: BOOKING_ID,
        status: "FAILED",
        failedAt: FAILED_AT,
      },
    });
    bookingRepository.findBookingSeatsByBookingId.mockResolvedValue(
      SCREENING_SEAT_IDS.map((screeningSeatId) => ({ screeningSeatId })),
    );
    screeningRepository.releaseBookedSeats.mockResolvedValue({
      count: SCREENING_SEAT_IDS.length,
    });

    await expect(service.pay(USER, PAYMENT_ID, PAYMENT_KEY)).resolves.toEqual({
      id: PAYMENT_ID,
      bookingId: BOOKING_ID,
      status: "FAILED",
      failedAt: FAILED_AT.toISOString(),
    });
    expect(paymentGateway.confirm).toHaveBeenCalledWith({
      paymentKey: PAYMENT_KEY,
      orderId: ORDER_ID,
      amount: AMOUNT,
    });
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(paymentRepository.payAuthorizingPayment).not.toHaveBeenCalled();
    expect(paymentRepository.failAuthorizingPayment).toHaveBeenCalledWith(
      TX,
      PAYMENT_ID,
      USER.id,
    );
    expect(bookingRepository.failPendingBooking).toHaveBeenCalledWith(
      TX,
      BOOKING_ID,
      USER.id,
      FAILED_AT,
    );
    expect(paymentRepository.failAuthorizingPayment.mock.invocationCallOrder[0]).toBeLessThan(
      bookingRepository.failPendingBooking.mock.invocationCallOrder[0] ?? 0,
    );
    expect(bookingRepository.failPendingBooking.mock.invocationCallOrder[0]).toBeLessThan(
      screeningRepository.releaseBookedSeats.mock.invocationCallOrder[0] ?? 0,
    );
    expect(screeningRepository.releaseBookedSeats).toHaveBeenCalledWith(
      TX,
      SCREENING_SEAT_IDS,
    );
  });

  it("rolls the failure back when the booking cannot be failed", async () => {
    paymentRepository.findOwnedPayment.mockResolvedValue(PENDING_PAYMENT);
    paymentGateway.confirm.mockResolvedValue({ status: "FAILED" });
    paymentRepository.failAuthorizingPayment.mockResolvedValue({
      result: FAIL_PAYMENT_RESULT.FAILED,
      payment: {
        id: PAYMENT_ID,
        bookingId: BOOKING_ID,
        status: "FAILED",
        failedAt: FAILED_AT,
      },
    });
    bookingRepository.failPendingBooking.mockResolvedValue({ count: 0 });

    await expect(service.pay(USER, PAYMENT_ID, PAYMENT_KEY)).rejects.toThrow(
      InternalServerErrorException,
    );
    expect(bookingRepository.findBookingSeatsByBookingId).not.toHaveBeenCalled();
    expect(screeningRepository.releaseBookedSeats).not.toHaveBeenCalled();
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it("requires reconciliation without retrieve when confirm is unknown after the deadline", async () => {
    paymentRepository.findOwnedPayment.mockResolvedValue(PENDING_PAYMENT);
    paymentRepository.beginAuthorization.mockResolvedValue(closedAuthorization());
    paymentGateway.confirm.mockResolvedValue({ status: "UNKNOWN" });
    bookingRepository.findBookingSeatsByBookingId.mockResolvedValue(
      SCREENING_SEAT_IDS.map((screeningSeatId) => ({ screeningSeatId })),
    );
    screeningRepository.releaseBookedSeats.mockResolvedValue({
      count: SCREENING_SEAT_IDS.length,
    });

    await expect(service.pay(USER, PAYMENT_ID, PAYMENT_KEY)).resolves.toEqual({
      id: PAYMENT_ID,
      bookingId: BOOKING_ID,
      status: "RECONCILIATION_REQUIRED",
    });
    expect(paymentGateway.confirm).toHaveBeenCalledTimes(1);
    expect(paymentGateway.retrieve).not.toHaveBeenCalled();
    expect(paymentRepository.payAuthorizingPayment).not.toHaveBeenCalled();
    expect(paymentRepository.failAuthorizingPayment).not.toHaveBeenCalled();
    expect(paymentRepository.reconcileAuthorizingPayment.mock.invocationCallOrder[0]).toBeLessThan(
      bookingRepository.cancelPendingBookingForReconciliation.mock.invocationCallOrder[0] ?? 0,
    );
    expect(
      bookingRepository.cancelPendingBookingForReconciliation.mock.invocationCallOrder[0],
    ).toBeLessThan(screeningRepository.releaseBookedSeats.mock.invocationCallOrder[0] ?? 0);
    expect(bookingRepository.cancelPendingBookingForReconciliation).toHaveBeenCalledWith(
      TX,
      BOOKING_ID,
      USER.id,
      expect.any(Date),
    );
    expect(bookingRepository.expirePendingBooking).not.toHaveBeenCalled();
    expect(bookingRepository.failPendingBooking).not.toHaveBeenCalled();
    expect(screeningRepository.releaseBookedSeats).toHaveBeenCalledWith(TX, SCREENING_SEAT_IDS);
    expect(
      screeningRepository.releaseBookedSeats.mock.invocationCallOrder[0],
    ).toBeLessThan(reconcilePaymentRepository.createOpen.mock.invocationCallOrder[0] ?? 0);
    expect(reconcilePaymentRepository.createOpen).toHaveBeenCalledWith(
      TX,
      PAYMENT_ID,
      expect.any(Date),
    );
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it("does not report paid when the authorizing update loses", async () => {
    paymentRepository.findOwnedPayment.mockResolvedValue(PENDING_PAYMENT);
    paymentGateway.confirm.mockResolvedValue({
      status: "SUCCESS",
      paymentKey: PAYMENT_KEY,
      orderId: ORDER_ID,
      amount: AMOUNT,
      approvedAt: PAID_AT,
    });
    paymentRepository.payAuthorizingPayment.mockResolvedValue({
      result: PAY_PAYMENT_RESULT.NOT_AUTHORIZING,
    });

    await expect(service.pay(USER, PAYMENT_ID, PAYMENT_KEY)).rejects.toThrow(
      new ConflictException("결제할 수 없는 상태입니다."),
    );
    expect(paymentRepository.findOwnedPayment).toHaveBeenCalledTimes(1);
    expect(bookingRepository.confirmPendingBooking).not.toHaveBeenCalled();
    expect(screeningRepository.releaseBookedSeats).not.toHaveBeenCalled();
    expect(paymentRepository.failAuthorizingPayment).not.toHaveBeenCalled();
  });

  it("rejects without releasing seats when confirm succeeds after authorization was already closed", async () => {
    paymentRepository.findOwnedPayment
      .mockResolvedValueOnce(PENDING_PAYMENT)
      .mockResolvedValueOnce({
        ...PENDING_PAYMENT,
        status: "FAILED",
        paymentKey: PAYMENT_KEY,
      });
    paymentGateway.confirm.mockResolvedValue({
      status: "SUCCESS",
      paymentKey: PAYMENT_KEY,
      orderId: ORDER_ID,
      amount: AMOUNT,
      approvedAt: PAID_AT,
    });
    paymentRepository.payAuthorizingPayment.mockResolvedValue({
      result: PAY_PAYMENT_RESULT.NOT_AUTHORIZING,
    });

    await expect(service.pay(USER, PAYMENT_ID, PAYMENT_KEY)).rejects.toThrow(
      new ConflictException("결제할 수 없는 상태입니다."),
    );
    expect(screeningRepository.releaseBookedSeats).not.toHaveBeenCalled();
    expect(paymentRepository.failAuthorizingPayment).not.toHaveBeenCalled();
  });

  it("rejects without releasing seats when confirm fails after authorization was already closed", async () => {
    paymentRepository.findOwnedPayment.mockResolvedValue(PENDING_PAYMENT);
    paymentGateway.confirm.mockResolvedValue({ status: "FAILED" });
    paymentRepository.failAuthorizingPayment.mockResolvedValue({
      result: FAIL_PAYMENT_RESULT.NOT_AUTHORIZING,
    });

    await expect(service.pay(USER, PAYMENT_ID, PAYMENT_KEY)).rejects.toThrow(
      new ConflictException("결제할 수 없는 상태입니다."),
    );
    expect(screeningRepository.releaseBookedSeats).not.toHaveBeenCalled();
    expect(paymentRepository.payAuthorizingPayment).not.toHaveBeenCalled();
  });

  it("does not fail the booking when confirm fails after authorization was already closed", async () => {
    paymentRepository.findOwnedPayment.mockResolvedValue(PENDING_PAYMENT);
    paymentGateway.confirm.mockResolvedValue({ status: "FAILED" });
    paymentRepository.failAuthorizingPayment.mockResolvedValue({
      result: FAIL_PAYMENT_RESULT.NOT_AUTHORIZING,
    });

    await expect(service.pay(USER, PAYMENT_ID, PAYMENT_KEY)).rejects.toThrow(
      new ConflictException("결제할 수 없는 상태입니다."),
    );
    expect(paymentRepository.findOwnedPayment).toHaveBeenCalledTimes(1);
    expect(bookingRepository.failPendingBooking).not.toHaveBeenCalled();
    expect(screeningRepository.releaseBookedSeats).not.toHaveBeenCalled();
    expect(paymentRepository.payAuthorizingPayment).not.toHaveBeenCalled();
  });

  it("returns not found when confirm fails and the payment is not owned", async () => {
    paymentRepository.findOwnedPayment.mockResolvedValue(PENDING_PAYMENT);
    paymentGateway.confirm.mockResolvedValue({ status: "FAILED" });
    paymentRepository.failAuthorizingPayment.mockResolvedValue({
      result: FAIL_PAYMENT_RESULT.NOT_FOUND,
    });

    await expect(service.pay(USER, PAYMENT_ID, PAYMENT_KEY)).rejects.toThrow(NotFoundException);
    expect(paymentRepository.findOwnedPayment).toHaveBeenCalledTimes(1);
    expect(bookingRepository.failPendingBooking).not.toHaveBeenCalled();
    expect(screeningRepository.releaseBookedSeats).not.toHaveBeenCalled();
  });

  it("rejects without releasing seats when confirm fails after the payment was already paid", async () => {
    paymentRepository.findOwnedPayment
      .mockResolvedValueOnce(PENDING_PAYMENT)
      .mockResolvedValueOnce({
        ...PENDING_PAYMENT,
        status: "PAID",
        paymentKey: PAYMENT_KEY,
        paidAt: PAID_AT,
      });
    paymentGateway.confirm.mockResolvedValue({ status: "FAILED" });
    paymentRepository.failAuthorizingPayment.mockResolvedValue({
      result: FAIL_PAYMENT_RESULT.NOT_AUTHORIZING,
    });

    await expect(service.pay(USER, PAYMENT_ID, PAYMENT_KEY)).rejects.toThrow(
      new ConflictException("결제할 수 없는 상태입니다."),
    );
    expect(screeningRepository.releaseBookedSeats).not.toHaveBeenCalled();
    expect(paymentRepository.payAuthorizingPayment).not.toHaveBeenCalled();
  });

  it("rolls back when seat release count does not match", async () => {
    paymentRepository.findOwnedPayment.mockResolvedValue(PENDING_PAYMENT);
    paymentGateway.confirm.mockResolvedValue({
      status: "FAILED",
    });
    paymentRepository.failAuthorizingPayment.mockResolvedValue({
      result: FAIL_PAYMENT_RESULT.FAILED,
      payment: {
        id: PAYMENT_ID,
        bookingId: BOOKING_ID,
        status: "FAILED",
        failedAt: FAILED_AT,
      },
    });
    bookingRepository.findBookingSeatsByBookingId.mockResolvedValue(
      SCREENING_SEAT_IDS.map((screeningSeatId) => ({ screeningSeatId })),
    );
    screeningRepository.releaseBookedSeats.mockResolvedValue({ count: 1 });

    await expect(service.pay(USER, PAYMENT_ID, PAYMENT_KEY)).rejects.toThrow(
      InternalServerErrorException,
    );
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it("pays from a retrieve started before the deadline", async () => {
    paymentRepository.findOwnedPayment.mockResolvedValue(PENDING_PAYMENT);
    paymentGateway.confirm.mockResolvedValue({ status: "UNKNOWN" });
    paymentGateway.retrieve.mockImplementation(async () => {
      expect(paymentRepository.payAuthorizingPayment).not.toHaveBeenCalled();
      return {
        status: "PAID",
        paymentKey: PAYMENT_KEY,
        orderId: ORDER_ID,
        amount: AMOUNT,
        approvedAt: PAID_AT,
      };
    });
    paymentRepository.payAuthorizingPayment.mockResolvedValue({
      result: PAY_PAYMENT_RESULT.PAID,
      payment: {
        id: PAYMENT_ID,
        bookingId: BOOKING_ID,
        status: "PAID",
        amount: AMOUNT,
        paidAt: PAID_AT,
      },
    });

    await expect(service.pay(USER, PAYMENT_ID, PAYMENT_KEY)).resolves.toEqual({
      id: PAYMENT_ID,
      bookingId: BOOKING_ID,
      status: "PAID",
      paidAt: PAID_AT.toISOString(),
    });
    expect(paymentGateway.retrieve).toHaveBeenCalledTimes(1);
    expect(paymentGateway.retrieve).toHaveBeenCalledWith({ paymentKey: PAYMENT_KEY });
    expect(paymentGateway.confirm.mock.invocationCallOrder[0]).toBeLessThan(
      paymentGateway.retrieve.mock.invocationCallOrder[0] ?? 0,
    );
    expect(paymentRepository.reconcileAuthorizingPayment).not.toHaveBeenCalled();
  });

  it("pays when a later retrieve matches after confirm identifiers do not", async () => {
    paymentRepository.findOwnedPayment.mockResolvedValue(PENDING_PAYMENT);
    paymentGateway.confirm.mockResolvedValue({
      status: "SUCCESS",
      paymentKey: PAYMENT_KEY,
      orderId: ORDER_ID,
      amount: AMOUNT + 1,
      approvedAt: PAID_AT,
    });
    paymentGateway.retrieve.mockResolvedValue({
      status: "PAID",
      paymentKey: PAYMENT_KEY,
      orderId: ORDER_ID,
      amount: AMOUNT,
      approvedAt: PAID_AT,
    });
    paymentRepository.payAuthorizingPayment.mockResolvedValue({
      result: PAY_PAYMENT_RESULT.PAID,
      payment: {
        id: PAYMENT_ID,
        bookingId: BOOKING_ID,
        status: "PAID",
        amount: AMOUNT,
        paidAt: PAID_AT,
      },
    });

    await expect(service.pay(USER, PAYMENT_ID, PAYMENT_KEY)).resolves.toEqual({
      id: PAYMENT_ID,
      bookingId: BOOKING_ID,
      status: "PAID",
      paidAt: PAID_AT.toISOString(),
    });
    expect(paymentRepository.reconcileAuthorizingPayment).not.toHaveBeenCalled();
  });

  it("fails from a retrieve started before the deadline", async () => {
    paymentRepository.findOwnedPayment.mockResolvedValue(PENDING_PAYMENT);
    paymentGateway.confirm.mockResolvedValue({ status: "UNKNOWN" });
    paymentGateway.retrieve.mockResolvedValue({ status: "NOT_PAID" });
    paymentRepository.failAuthorizingPayment.mockResolvedValue({
      result: FAIL_PAYMENT_RESULT.FAILED,
      payment: {
        id: PAYMENT_ID,
        bookingId: BOOKING_ID,
        status: "FAILED",
        failedAt: FAILED_AT,
      },
    });
    bookingRepository.findBookingSeatsByBookingId.mockResolvedValue([]);

    await expect(service.pay(USER, PAYMENT_ID, PAYMENT_KEY)).resolves.toEqual({
      id: PAYMENT_ID,
      bookingId: BOOKING_ID,
      status: "FAILED",
      failedAt: FAILED_AT.toISOString(),
    });
    expect(paymentRepository.reconcileAuthorizingPayment).not.toHaveBeenCalled();
    expect(bookingRepository.cancelPendingBookingForReconciliation).not.toHaveBeenCalled();
  });

  it("applies an unknown retrieve that reaches the deadline and does not retrieve again", async () => {
    jest.useFakeTimers({
      doNotFake: ["nextTick", "queueMicrotask", "setImmediate", "setTimeout", "setInterval"],
    });
    const start = new Date("2026-10-12T00:00:00.000Z");
    jest.setSystemTime(start);

    try {
      paymentRepository.findOwnedPayment.mockResolvedValue(PENDING_PAYMENT);
      paymentRepository.beginAuthorization.mockResolvedValue({
        result: BEGIN_AUTHORIZATION_RESULT.AUTHORIZING,
        authorizationExpiresAt: new Date(start.getTime() + 1_000),
      });
      paymentGateway.confirm.mockResolvedValue({ status: "UNKNOWN" });
      paymentGateway.retrieve.mockImplementation(async () => {
        jest.setSystemTime(start.getTime() + 1_000);
        return { status: "UNKNOWN" };
      });
      bookingRepository.findBookingSeatsByBookingId.mockResolvedValue([]);

      await expect(service.pay(USER, PAYMENT_ID, PAYMENT_KEY)).resolves.toEqual({
        id: PAYMENT_ID,
        bookingId: BOOKING_ID,
        status: "RECONCILIATION_REQUIRED",
      });
      expect(paymentGateway.retrieve).toHaveBeenCalledTimes(1);
      expect(screeningRepository.releaseBookedSeats).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it("keeps a clear failure when that response is processed at the deadline", async () => {
    jest.useFakeTimers({
      doNotFake: ["nextTick", "queueMicrotask", "setImmediate", "setTimeout", "setInterval"],
    });
    const start = new Date("2026-10-12T00:00:00.000Z");
    jest.setSystemTime(start);

    try {
      paymentRepository.findOwnedPayment.mockResolvedValue(PENDING_PAYMENT);
      paymentRepository.beginAuthorization.mockResolvedValue({
        result: BEGIN_AUTHORIZATION_RESULT.AUTHORIZING,
        authorizationExpiresAt: new Date(start.getTime() + 1_000),
      });
      paymentGateway.confirm.mockImplementation(async () => {
        jest.setSystemTime(start.getTime() + 1_000);
        return { status: "FAILED" };
      });
      paymentRepository.failAuthorizingPayment.mockResolvedValue({
        result: FAIL_PAYMENT_RESULT.FAILED,
        payment: {
          id: PAYMENT_ID,
          bookingId: BOOKING_ID,
          status: "FAILED",
          failedAt: FAILED_AT,
        },
      });
      bookingRepository.findBookingSeatsByBookingId.mockResolvedValue([]);

      await expect(service.pay(USER, PAYMENT_ID, PAYMENT_KEY)).resolves.toEqual({
        id: PAYMENT_ID,
        bookingId: BOOKING_ID,
        status: "FAILED",
        failedAt: FAILED_AT.toISOString(),
      });
      expect(paymentRepository.reconcileAuthorizingPayment).not.toHaveBeenCalled();
      expect(bookingRepository.cancelPendingBookingForReconciliation).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it.each([
    ["1ms before the deadline", -1, "PAID"],
    ["exactly at the deadline", 0, "RECONCILIATION_REQUIRED"],
    ["1ms after the deadline", 1, "RECONCILIATION_REQUIRED"],
  ] as const)(
    "classifies an in-flight retrieve PAID %s",
    async (_label, offsetMs, expectedStatus) => {
      jest.useFakeTimers({
        doNotFake: ["nextTick", "queueMicrotask", "setImmediate", "setTimeout", "setInterval"],
      });
      const start = new Date("2026-10-12T00:00:00.000Z");
      const deadline = new Date(start.getTime() + 1_000);
      jest.setSystemTime(start);

      try {
        paymentRepository.findOwnedPayment.mockResolvedValue(PENDING_PAYMENT);
        paymentRepository.beginAuthorization.mockResolvedValue({
          result: BEGIN_AUTHORIZATION_RESULT.AUTHORIZING,
          authorizationExpiresAt: deadline,
        });
        paymentGateway.confirm.mockResolvedValue({ status: "UNKNOWN" });
        paymentGateway.retrieve.mockImplementation(async () => {
          jest.setSystemTime(deadline.getTime() + offsetMs);
          return {
            status: "PAID",
            paymentKey: PAYMENT_KEY,
            orderId: ORDER_ID,
            amount: AMOUNT,
            approvedAt: PAID_AT,
          };
        });
        paymentRepository.payAuthorizingPayment.mockResolvedValue({
          result: PAY_PAYMENT_RESULT.PAID,
          payment: {
            id: PAYMENT_ID,
            bookingId: BOOKING_ID,
            status: "PAID",
            amount: AMOUNT,
            paidAt: PAID_AT,
          },
        });
        bookingRepository.findBookingSeatsByBookingId.mockResolvedValue(
          SCREENING_SEAT_IDS.map((screeningSeatId) => ({ screeningSeatId })),
        );
        screeningRepository.releaseBookedSeats.mockResolvedValue({
          count: SCREENING_SEAT_IDS.length,
        });

        const result = await service.pay(USER, PAYMENT_ID, PAYMENT_KEY);

        expect(paymentGateway.retrieve).toHaveBeenCalledTimes(1);
        if (expectedStatus === "PAID") {
          expect(result).toEqual({
            id: PAYMENT_ID,
            bookingId: BOOKING_ID,
            status: "PAID",
            paidAt: PAID_AT.toISOString(),
          });
          expect(paymentRepository.payAuthorizingPayment).toHaveBeenCalledWith(
            TX,
            PAYMENT_ID,
            USER.id,
            PAYMENT_KEY,
            new Date(deadline.getTime() + offsetMs),
          );
          expect(paymentRepository.reconcileAuthorizingPayment).not.toHaveBeenCalled();
          expect(screeningRepository.releaseBookedSeats).not.toHaveBeenCalled();
          expect(reconcilePaymentRepository.createOpen).not.toHaveBeenCalled();
          return;
        }

        expect(result).toEqual({
          id: PAYMENT_ID,
          bookingId: BOOKING_ID,
          status: "RECONCILIATION_REQUIRED",
        });
        expect(paymentRepository.payAuthorizingPayment).not.toHaveBeenCalled();
        expect(paymentRepository.reconcileAuthorizingPayment).toHaveBeenCalledWith(
          TX,
          PAYMENT_ID,
          USER.id,
          new Date(deadline.getTime() + offsetMs),
        );
        expect(bookingRepository.cancelPendingBookingForReconciliation).toHaveBeenCalledWith(
          TX,
          BOOKING_ID,
          USER.id,
          new Date(deadline.getTime() + offsetMs),
        );
        expect(screeningRepository.releaseBookedSeats).toHaveBeenCalledWith(TX, SCREENING_SEAT_IDS);
        expect(reconcilePaymentRepository.createOpen).toHaveBeenCalledWith(
          TX,
          PAYMENT_ID,
          new Date(deadline.getTime() + offsetMs),
        );
      } finally {
        jest.useRealTimers();
      }
    },
  );

  it("retrieves again after the interval while the deadline is still open", async () => {
    jest.useFakeTimers();
    const start = new Date("2026-10-12T00:00:00.000Z");
    jest.setSystemTime(start);

    try {
      paymentRepository.findOwnedPayment.mockResolvedValue(PENDING_PAYMENT);
      paymentRepository.beginAuthorization.mockResolvedValue({
        result: BEGIN_AUTHORIZATION_RESULT.AUTHORIZING,
        authorizationExpiresAt: new Date(start.getTime() + 10_000),
      });
      paymentGateway.confirm.mockResolvedValue({ status: "UNKNOWN" });
      paymentGateway.retrieve
        .mockResolvedValueOnce({ status: "UNKNOWN" })
        .mockResolvedValueOnce({
          status: "PAID",
          paymentKey: PAYMENT_KEY,
          orderId: ORDER_ID,
          amount: AMOUNT,
          approvedAt: PAID_AT,
        });
      paymentRepository.payAuthorizingPayment.mockResolvedValue({
        result: PAY_PAYMENT_RESULT.PAID,
        payment: {
          id: PAYMENT_ID,
          bookingId: BOOKING_ID,
          status: "PAID",
          amount: AMOUNT,
          paidAt: PAID_AT,
        },
      });

      const pending = service.pay(USER, PAYMENT_ID, PAYMENT_KEY);
      await jest.advanceTimersByTimeAsync(PAYMENT_AUTHORIZING_RETRIEVE_INTERVAL_MS);

      await expect(pending).resolves.toEqual({
        id: PAYMENT_ID,
        bookingId: BOOKING_ID,
        status: "PAID",
        paidAt: PAID_AT.toISOString(),
      });
      expect(paymentGateway.retrieve).toHaveBeenCalledTimes(2);
      expect(paymentRepository.reconcileAuthorizingPayment).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it("does not expire the booking when reconciliation loses the payment update", async () => {
    paymentRepository.findOwnedPayment.mockResolvedValue(PENDING_PAYMENT);
    paymentRepository.beginAuthorization.mockResolvedValue(closedAuthorization());
    paymentGateway.confirm.mockResolvedValue({ status: "UNKNOWN" });
    paymentRepository.reconcileAuthorizingPayment.mockResolvedValue({
      result: RECONCILE_AUTHORIZING_PAYMENT_RESULT.NOT_AUTHORIZING,
    });

    await expect(service.pay(USER, PAYMENT_ID, PAYMENT_KEY)).rejects.toThrow(
      new ConflictException("결제할 수 없는 상태입니다."),
    );
    expect(bookingRepository.cancelPendingBookingForReconciliation).not.toHaveBeenCalled();
    expect(reconcilePaymentRepository.createOpen).not.toHaveBeenCalled();
    expect(bookingRepository.findBookingSeatsByBookingId).not.toHaveBeenCalled();
    expect(screeningRepository.releaseBookedSeats).not.toHaveBeenCalled();
  });

  it("rolls reconciliation back when the booking cannot be cancelled", async () => {
    paymentRepository.findOwnedPayment.mockResolvedValue(PENDING_PAYMENT);
    paymentRepository.beginAuthorization.mockResolvedValue(closedAuthorization());
    paymentGateway.confirm.mockResolvedValue({ status: "UNKNOWN" });
    bookingRepository.cancelPendingBookingForReconciliation.mockResolvedValue({ count: 0 });

    await expect(service.pay(USER, PAYMENT_ID, PAYMENT_KEY)).rejects.toThrow(
      InternalServerErrorException,
    );
    expect(paymentRepository.reconcileAuthorizingPayment).toHaveBeenCalledTimes(1);
    expect(bookingRepository.findBookingSeatsByBookingId).not.toHaveBeenCalled();
    expect(screeningRepository.releaseBookedSeats).not.toHaveBeenCalled();
    expect(reconcilePaymentRepository.createOpen).not.toHaveBeenCalled();
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it("rolls reconciliation back when a booked seat cannot be released", async () => {
    paymentRepository.findOwnedPayment.mockResolvedValue(PENDING_PAYMENT);
    paymentRepository.beginAuthorization.mockResolvedValue(closedAuthorization());
    paymentGateway.confirm.mockResolvedValue({ status: "UNKNOWN" });
    bookingRepository.findBookingSeatsByBookingId.mockResolvedValue(
      SCREENING_SEAT_IDS.map((screeningSeatId) => ({ screeningSeatId })),
    );
    screeningRepository.releaseBookedSeats.mockResolvedValue({ count: 1 });

    await expect(service.pay(USER, PAYMENT_ID, PAYMENT_KEY)).rejects.toThrow(
      InternalServerErrorException,
    );
    expect(paymentRepository.reconcileAuthorizingPayment.mock.invocationCallOrder[0]).toBeLessThan(
      bookingRepository.cancelPendingBookingForReconciliation.mock.invocationCallOrder[0] ?? 0,
    );
    expect(reconcilePaymentRepository.createOpen).not.toHaveBeenCalled();
    expect(transaction).toHaveBeenCalledTimes(2);
  });
});
