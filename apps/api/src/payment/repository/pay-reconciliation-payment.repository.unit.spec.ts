/**
 * Test Intent:
 * RECONCILIATION_REQUIRED Payment만 PAID로 바뀌고 paidAt이 전달 시각으로 기록됨을 보장한다.
 * Payment가 없거나 상태가 RECONCILIATION_REQUIRED가 아니면 변경하지 않는다.
 * 사용자·Booking 조건은 쓰지 않으며 paymentKey는 다시 기록하지 않는다.
 */

import { jest } from "@jest/globals";
import { Prisma } from "@movie-booking/database-prisma";
import {
  PAY_RECONCILIATION_PAYMENT_RESULT,
  PAYMENT_PAID_STATUS,
  PAYMENT_RECONCILIATION_REQUIRED_STATUS,
} from "../payment.constants.js";
import { PaymentRepository } from "./payment.repository.js";

const PAYMENT_ID = "550e8400-e29b-41d4-a716-446655440030";
const BOOKING_ID = "550e8400-e29b-41d4-a716-446655440020";
const PAID_AT = new Date("2026-10-31T12:00:00.000Z");
const AMOUNT = 10_000;

type UpdateMany = (args: {
  where: { id: string; status?: string; booking?: unknown };
  data: {
    status: string;
    paidAt?: Date;
    paymentKey?: string;
  };
}) => Promise<{ count: number }>;

type FindPayment = () => Promise<{
  id: string;
  bookingId?: string;
  status?: string;
  amount?: number;
  paidAt?: Date;
} | null>;

describe("PaymentRepository.payReconciliationPayment", () => {
  let repository: PaymentRepository;
  let paymentUpdateMany: jest.MockedFunction<UpdateMany>;
  let paymentFindUnique: jest.MockedFunction<FindPayment>;
  let paymentFindUniqueOrThrow: jest.MockedFunction<FindPayment>;
  let tx: Prisma.TransactionClient;

  beforeEach(() => {
    paymentUpdateMany = jest.fn<UpdateMany>();
    paymentFindUnique = jest.fn<FindPayment>();
    paymentFindUniqueOrThrow = jest.fn<FindPayment>();
    tx = {
      payment: {
        updateMany: paymentUpdateMany,
        findUnique: paymentFindUnique,
        findUniqueOrThrow: paymentFindUniqueOrThrow,
      },
    } as unknown as Prisma.TransactionClient;
    repository = new PaymentRepository({} as never);
  });

  it("pays a reconciliation-required payment with the provided paidAt", async () => {
    paymentUpdateMany.mockResolvedValue({ count: 1 });
    paymentFindUniqueOrThrow.mockResolvedValue({
      id: PAYMENT_ID,
      bookingId: BOOKING_ID,
      status: PAYMENT_PAID_STATUS,
      amount: AMOUNT,
      paidAt: PAID_AT,
    });

    const result = await repository.payReconciliationPayment(tx, PAYMENT_ID, PAID_AT);

    expect(paymentUpdateMany).toHaveBeenCalledWith({
      where: {
        id: PAYMENT_ID,
        status: PAYMENT_RECONCILIATION_REQUIRED_STATUS,
      },
      data: {
        status: PAYMENT_PAID_STATUS,
        paidAt: PAID_AT,
      },
    });
    expect(paymentUpdateMany.mock.calls[0]?.[0].where).not.toHaveProperty("booking");
    expect(paymentUpdateMany.mock.calls[0]?.[0].data).not.toHaveProperty("paymentKey");
    expect(result).toEqual({
      result: PAY_RECONCILIATION_PAYMENT_RESULT.PAID,
      payment: {
        id: PAYMENT_ID,
        bookingId: BOOKING_ID,
        status: PAYMENT_PAID_STATUS,
        amount: AMOUNT,
        paidAt: PAID_AT,
      },
    });
  });

  it("returns NOT_FOUND when the payment does not exist", async () => {
    paymentUpdateMany.mockResolvedValue({ count: 0 });
    paymentFindUnique.mockResolvedValue(null);

    await expect(
      repository.payReconciliationPayment(tx, PAYMENT_ID, PAID_AT),
    ).resolves.toEqual({
      result: PAY_RECONCILIATION_PAYMENT_RESULT.NOT_FOUND,
    });
  });

  it.each(["PENDING", "AUTHORIZING", "PAID", "FAILED", "EXPIRED", "CANCELED"])(
    "does not pay a %s payment",
    async () => {
      paymentUpdateMany.mockResolvedValue({ count: 0 });
      paymentFindUnique.mockResolvedValue({ id: PAYMENT_ID });

      await expect(
        repository.payReconciliationPayment(tx, PAYMENT_ID, PAID_AT),
      ).resolves.toEqual({
        result: PAY_RECONCILIATION_PAYMENT_RESULT.NOT_RECONCILIATION_REQUIRED,
      });
      expect(paymentUpdateMany.mock.calls[0]?.[0].where.status).toBe(
        PAYMENT_RECONCILIATION_REQUIRED_STATUS,
      );
    },
  );
});
