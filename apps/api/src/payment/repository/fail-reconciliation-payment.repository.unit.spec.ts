/**
 * Test Intent:
 * RECONCILIATION_REQUIRED Payment만 FAILED로 바뀌고 failedAt이 전달 시각으로 기록됨을 보장한다.
 * Payment가 없거나 상태가 RECONCILIATION_REQUIRED가 아니면 변경하지 않는다. 사용자·Booking 조건은 쓰지 않는다.
 */

import { jest } from "@jest/globals";
import { Prisma } from "@movie-booking/database-prisma";
import {
  FAIL_RECONCILIATION_PAYMENT_RESULT,
  PAYMENT_FAILED_STATUS,
  PAYMENT_RECONCILIATION_REQUIRED_STATUS,
} from "../payment.constants.js";
import { PaymentRepository } from "./payment.repository.js";

const PAYMENT_ID = "550e8400-e29b-41d4-a716-446655440030";
const BOOKING_ID = "550e8400-e29b-41d4-a716-446655440020";
const FAILED_AT = new Date("2026-10-31T12:00:00.000Z");

type UpdateMany = (args: {
  where: { id: string; status?: string; booking?: unknown };
  data: {
    status: string;
    failedAt?: Date;
  };
}) => Promise<{ count: number }>;

type FindPayment = () => Promise<{
  id: string;
  bookingId?: string;
  status?: string;
  failedAt?: Date;
} | null>;

describe("PaymentRepository.failReconciliationPayment", () => {
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

  it("fails a reconciliation-required payment with the provided failedAt", async () => {
    paymentUpdateMany.mockResolvedValue({ count: 1 });
    paymentFindUniqueOrThrow.mockResolvedValue({
      id: PAYMENT_ID,
      bookingId: BOOKING_ID,
      status: PAYMENT_FAILED_STATUS,
      failedAt: FAILED_AT,
    });

    const result = await repository.failReconciliationPayment(tx, PAYMENT_ID, FAILED_AT);

    expect(paymentUpdateMany).toHaveBeenCalledWith({
      where: {
        id: PAYMENT_ID,
        status: PAYMENT_RECONCILIATION_REQUIRED_STATUS,
      },
      data: {
        status: PAYMENT_FAILED_STATUS,
        failedAt: FAILED_AT,
      },
    });
    expect(paymentUpdateMany.mock.calls[0]?.[0].where).not.toHaveProperty("booking");
    expect(result).toEqual({
      result: FAIL_RECONCILIATION_PAYMENT_RESULT.FAILED,
      payment: {
        id: PAYMENT_ID,
        bookingId: BOOKING_ID,
        status: PAYMENT_FAILED_STATUS,
        failedAt: FAILED_AT,
      },
    });
  });

  it("returns NOT_FOUND when the payment does not exist", async () => {
    paymentUpdateMany.mockResolvedValue({ count: 0 });
    paymentFindUnique.mockResolvedValue(null);

    await expect(
      repository.failReconciliationPayment(tx, PAYMENT_ID, FAILED_AT),
    ).resolves.toEqual({
      result: FAIL_RECONCILIATION_PAYMENT_RESULT.NOT_FOUND,
    });
  });

  it.each(["PENDING", "AUTHORIZING", "PAID", "FAILED", "EXPIRED", "CANCELED"])(
    "does not fail a %s payment",
    async () => {
      paymentUpdateMany.mockResolvedValue({ count: 0 });
      paymentFindUnique.mockResolvedValue({ id: PAYMENT_ID });

      await expect(
        repository.failReconciliationPayment(tx, PAYMENT_ID, FAILED_AT),
      ).resolves.toEqual({
        result: FAIL_RECONCILIATION_PAYMENT_RESULT.NOT_RECONCILIATION_REQUIRED,
      });
      expect(paymentUpdateMany.mock.calls[0]?.[0].where.status).toBe(
        PAYMENT_RECONCILIATION_REQUIRED_STATUS,
      );
    },
  );
});
