/**
 * Test Intent:
 * 대사용 Payment 조회는 orderId, amount, paymentKey만 반환한다. Payment가 없으면 null이다.
 * Payment가 있는데 paymentKey가 없으면 데이터 무결성 예외다.
 */

import { jest } from "@jest/globals";
import { InternalServerErrorException } from "@nestjs/common";
import { PaymentRepository } from "./payment.repository.js";

const PAYMENT_ID = "550e8400-e29b-41d4-a716-446655440030";
const ORDER_ID = "ord_550e8400-e29b-41d4-a716-446655440030";
const AMOUNT = 10_000;
const PAYMENT_KEY = "pay-key";

type FindUnique = (args: {
  where: { id: string };
  select: {
    orderId: true;
    amount: true;
    paymentKey: true;
  };
}) => Promise<{
  orderId: string;
  amount: number;
  paymentKey: string | null;
} | null>;

describe("PaymentRepository.findReconciliationPayment", () => {
  let findUnique: jest.MockedFunction<FindUnique>;
  let repository: PaymentRepository;

  beforeEach(() => {
    findUnique = jest.fn<FindUnique>();
    repository = new PaymentRepository({
      client: { payment: { findUnique } },
    } as never);
  });

  it("returns orderId, amount, and paymentKey for an existing payment", async () => {
    findUnique.mockResolvedValue({
      orderId: ORDER_ID,
      amount: AMOUNT,
      paymentKey: PAYMENT_KEY,
    });

    await expect(repository.findReconciliationPayment(PAYMENT_ID)).resolves.toEqual({
      orderId: ORDER_ID,
      amount: AMOUNT,
      paymentKey: PAYMENT_KEY,
    });
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: PAYMENT_ID },
      select: {
        orderId: true,
        amount: true,
        paymentKey: true,
      },
    });
  });

  it("returns null when the payment does not exist", async () => {
    findUnique.mockResolvedValue(null);

    await expect(repository.findReconciliationPayment(PAYMENT_ID)).resolves.toBeNull();
  });

  it("rejects when the payment exists without a paymentKey", async () => {
    findUnique.mockResolvedValue({
      orderId: ORDER_ID,
      amount: AMOUNT,
      paymentKey: null,
    });

    await expect(repository.findReconciliationPayment(PAYMENT_ID)).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
  });
});
