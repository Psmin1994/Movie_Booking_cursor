/**
 * Test Intent:
 * 보유 시간이 남은 본인 PENDING Booking만, Booking.totalAmount와 서버가 정한 주문번호로 PENDING Payment가 됨을 보장한다. 예매를 먼저 잠그며, 타인 예매, 기존 결제, 만료, 동시 생성은 거절한다.
 */

import { jest } from "@jest/globals";
import { Prisma } from "@movie-booking/database-prisma";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { BOOKING_EXPIRED_STATUS, BOOKING_PENDING_STATUS } from "../../booking/booking.constants.js";
import { BookingRepository } from "../../booking/repository/booking.repository.js";
import { PrismaService } from "../../database/prisma.service.js";
import { CreatePaymentService } from "./create-payment.service.js";
import { PAYMENT_PENDING_STATUS } from "../payment.constants.js";
import { PaymentRepository } from "../repository/payment.repository.js";

const USER_ID = "550e8400-e29b-41d4-a716-446655440000";
const OTHER_USER_ID = "550e8400-e29b-41d4-a716-446655440001";
const BOOKING_ID = "550e8400-e29b-41d4-a716-446655440020";
const PAYMENT_ID = "550e8400-e29b-41d4-a716-446655440030";
const EXISTING_PAYMENT_ID = "550e8400-e29b-41d4-a716-446655440031";
const BOOKING_TOTAL_AMOUNT = 30_000;
const USER = { id: USER_ID, email: "user@example.com" };
const DTO = { bookingId: BOOKING_ID };
const TX = { name: "transaction-client" } as unknown as Prisma.TransactionClient;
const FUTURE = new Date("2099-01-01T00:00:00.000Z");
const PAST = new Date("2000-01-01T00:00:00.000Z");

function ownedBooking(overrides?: Partial<{
  totalAmount: number;
  status: string;
  expiresAt: Date;
  paymentId: string | null;
}>) {
  return {
    totalAmount: BOOKING_TOTAL_AMOUNT,
    status: BOOKING_PENDING_STATUS,
    expiresAt: FUTURE,
    paymentId: null,
    ...overrides,
  };
}

type RunTransaction = (
  callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
) => Promise<unknown>;

describe("CreatePaymentService", () => {
  let service: CreatePaymentService;
  let bookingRepository: {
    lockBookingById: jest.MockedFunction<BookingRepository["lockBookingById"]>;
    findBookingByIdAndUserId: jest.MockedFunction<
      BookingRepository["findBookingByIdAndUserId"]
    >;
  };
  let paymentRepository: {
    createPendingPayment: jest.MockedFunction<
      PaymentRepository["createPendingPayment"]
    >;
  };
  let transaction: jest.MockedFunction<RunTransaction>;

  beforeEach(async () => {
    bookingRepository = {
      lockBookingById: jest.fn<BookingRepository["lockBookingById"]>(),
      findBookingByIdAndUserId:
        jest.fn<BookingRepository["findBookingByIdAndUserId"]>(),
    };
    paymentRepository = {
      createPendingPayment: jest.fn<PaymentRepository["createPendingPayment"]>(),
    };
    transaction = jest.fn<RunTransaction>(async (callback) => callback(TX));

    const moduleRef = await Test.createTestingModule({
      providers: [
        CreatePaymentService,
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
          provide: PaymentRepository,
          useValue: paymentRepository,
        },
      ],
    }).compile();

    service = moduleRef.get(CreatePaymentService);
  });

  it("creates a pending payment for the user's booking", async () => {
    bookingRepository.findBookingByIdAndUserId.mockResolvedValue(ownedBooking());
    paymentRepository.createPendingPayment.mockImplementation(
      async (_tx, _bookingId, amount, orderId) => ({
        id: PAYMENT_ID,
        orderId,
        amount,
        status: PAYMENT_PENDING_STATUS,
      }),
    );

    const result = await service.execute(USER, DTO);

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(bookingRepository.lockBookingById).toHaveBeenCalledWith(TX, BOOKING_ID);
    expect(bookingRepository.lockBookingById.mock.invocationCallOrder[0]).toBeLessThan(
      bookingRepository.findBookingByIdAndUserId.mock.invocationCallOrder[0] ?? 0,
    );
    expect(bookingRepository.findBookingByIdAndUserId).toHaveBeenCalledWith(
      TX,
      BOOKING_ID,
      USER_ID,
    );
    expect(paymentRepository.createPendingPayment).toHaveBeenCalledWith(
      TX,
      BOOKING_ID,
      BOOKING_TOTAL_AMOUNT,
      expect.stringMatching(/^ord_[A-Za-z0-9_-]{6,64}$/),
    );

    const orderId = paymentRepository.createPendingPayment.mock.calls[0]?.[3];

    expect(result).toEqual({
      id: PAYMENT_ID,
      orderId,
      amount: BOOKING_TOTAL_AMOUNT,
      status: PAYMENT_PENDING_STATUS,
    });
  });

  it("uses Booking.totalAmount instead of a client amount", async () => {
    bookingRepository.findBookingByIdAndUserId.mockResolvedValue(ownedBooking());
    paymentRepository.createPendingPayment.mockImplementation(
      async (_tx, _bookingId, amount, orderId) => ({
        id: PAYMENT_ID,
        orderId,
        amount,
        status: PAYMENT_PENDING_STATUS,
      }),
    );

    const result = await service.execute(USER, { bookingId: BOOKING_ID });

    expect(paymentRepository.createPendingPayment).toHaveBeenCalledWith(
      TX,
      BOOKING_ID,
      BOOKING_TOTAL_AMOUNT,
      expect.any(String),
    );
    expect(result.amount).toBe(BOOKING_TOTAL_AMOUNT);
  });

  it("generates orderId on the server", async () => {
    bookingRepository.findBookingByIdAndUserId.mockResolvedValue(ownedBooking());
    paymentRepository.createPendingPayment.mockImplementation(
      async (_tx, _bookingId, amount, orderId) => ({
        id: PAYMENT_ID,
        orderId,
        amount,
        status: PAYMENT_PENDING_STATUS,
      }),
    );

    const result = await service.execute(USER, DTO);
    const orderId = paymentRepository.createPendingPayment.mock.calls[0]?.[3];

    expect(orderId).toEqual(expect.stringMatching(/^ord_[0-9a-f-]{36}$/));
    expect(result.orderId).toBe(orderId);
    expect(DTO).toEqual({ bookingId: BOOKING_ID });
  });

  it("rejects a booking that does not belong to the current user", async () => {
    bookingRepository.findBookingByIdAndUserId.mockResolvedValue(null);

    await expect(
      service.execute({ id: OTHER_USER_ID, email: "other@example.com" }, DTO),
    ).rejects.toThrow(new NotFoundException("예매를 찾을 수 없습니다."));

    expect(bookingRepository.findBookingByIdAndUserId).toHaveBeenCalledWith(
      TX,
      BOOKING_ID,
      OTHER_USER_ID,
    );
    expect(paymentRepository.createPendingPayment).not.toHaveBeenCalled();
  });

  it("rejects a booking that already has a payment", async () => {
    bookingRepository.findBookingByIdAndUserId.mockResolvedValue(
      ownedBooking({ paymentId: EXISTING_PAYMENT_ID }),
    );

    await expect(service.execute(USER, DTO)).rejects.toThrow(
      new ConflictException("이미 결제가 생성된 예매입니다."),
    );

    expect(paymentRepository.createPendingPayment).not.toHaveBeenCalled();
  });

  it("rejects a concurrent payment created for the same booking", async () => {
    bookingRepository.findBookingByIdAndUserId.mockResolvedValue(ownedBooking());
    paymentRepository.createPendingPayment.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "7.10.0",
        meta: { target: ["bookingId"] },
      }),
    );

    await expect(service.execute(USER, DTO)).rejects.toThrow(
      new ConflictException("이미 결제가 생성된 예매입니다."),
    );
  });

  it("rejects an expired booking", async () => {
    bookingRepository.findBookingByIdAndUserId.mockResolvedValue(
      ownedBooking({ status: BOOKING_EXPIRED_STATUS }),
    );

    await expect(service.execute(USER, DTO)).rejects.toThrow(
      new ConflictException("결제할 수 없는 예매입니다."),
    );

    expect(paymentRepository.createPendingPayment).not.toHaveBeenCalled();
  });

  it("rejects a pending booking whose seat hold has reached expiresAt", async () => {
    const now = new Date("2026-09-28T12:00:00.000Z");
    const nowSpy = jest.spyOn(Date, "now").mockReturnValue(now.getTime());
    bookingRepository.findBookingByIdAndUserId.mockResolvedValue(
      ownedBooking({ expiresAt: now }),
    );

    await expect(service.execute(USER, DTO)).rejects.toThrow(
      new ConflictException("결제할 수 없는 예매입니다."),
    );

    expect(paymentRepository.createPendingPayment).not.toHaveBeenCalled();
    nowSpy.mockRestore();
  });

  it("rejects a pending booking after expiresAt", async () => {
    bookingRepository.findBookingByIdAndUserId.mockResolvedValue(
      ownedBooking({ expiresAt: PAST }),
    );

    await expect(service.execute(USER, DTO)).rejects.toThrow(
      new ConflictException("결제할 수 없는 예매입니다."),
    );

    expect(paymentRepository.createPendingPayment).not.toHaveBeenCalled();
  });
});
