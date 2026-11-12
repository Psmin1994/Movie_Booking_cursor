import { randomUUID } from "node:crypto";

const ORDER_ID_PATTERN = /^[A-Za-z0-9_-]{6,64}$/;

export function createPaymentOrderId(): string {
  const orderId = `ord_${randomUUID()}`;

  if (!ORDER_ID_PATTERN.test(orderId)) {
    throw new Error("Generated payment orderId is invalid.");
  }

  return orderId;
}
