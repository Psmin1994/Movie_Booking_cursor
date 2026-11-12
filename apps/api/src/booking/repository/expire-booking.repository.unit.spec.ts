/**
 * Test Intent:
 * Booking을 잠근 뒤에만 만료할 수 있고, 결제가 없으며 보유 시각이 지난 PENDING Booking만 EXPIRED가 됨을 보장한다. 소유자 조건이 있는 만료와 기한만 보는 만료를 구분한다. Reconciliation은 보유 시각과 무관하게 소유자의 PENDING Booking을 CANCELLED로 바꾸고 cancelledAt을 기록한다. Payment는 이 변경에서 바뀌지 않는다.
 */

import { jest } from "@jest/globals";
import { Prisma } from "@movie-booking/database-prisma";
import {
  BOOKING_CANCELLED_STATUS,
  BOOKING_EXPIRED_STATUS,
  BOOKING_PENDING_STATUS,
} from "../booking.constants.js";
import { BookingRepository } from "./booking.repository.js";

const USER_ID = "550e8400-e29b-41d4-a716-446655440000";
const BOOKING_ID = "550e8400-e29b-41d4-a716-446655440020";
const NOW = new Date("2026-09-28T12:00:00.000Z");

describe("BookingRepository expiration predicates", () => {
  const repository = new BookingRepository({} as never);

  it("locks the booking row before either use case changes it", async () => {
    const queryRaw = jest.fn<(strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>>();
    queryRaw.mockResolvedValue([]);
    const tx = { $queryRaw: queryRaw } as unknown as Prisma.TransactionClient;

    await repository.lockBookingById(tx, BOOKING_ID);

    const sql = queryRaw.mock.calls[0]?.[0].join("");
    expect(sql).toContain('FROM "Booking"');
    expect(sql).toContain("FOR UPDATE");
    expect(queryRaw.mock.calls[0]?.[1]).toBe(BOOKING_ID);
  });

  it("expires only a pending booking that has no payment and has reached expiresAt", async () => {
    const updateMany = jest.fn<(args: unknown) => Promise<{ count: number }>>();
    updateMany.mockResolvedValue({ count: 1 });
    const tx = {
      booking: { updateMany },
    } as unknown as Prisma.TransactionClient;

    await repository.expirePendingBookingWithoutPayment(tx, BOOKING_ID, NOW);

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: BOOKING_ID,
        status: BOOKING_PENDING_STATUS,
        expiresAt: { lte: NOW },
        payment: { is: null },
      },
      data: {
        status: BOOKING_EXPIRED_STATUS,
      },
    });
  });

  it("finds pending booking ids that have no payment and have reached expiresAt", async () => {
    const limit = 25;
    const findMany = jest.fn<(args: unknown) => Promise<{ id: string }[]>>();
    findMany.mockResolvedValue([{ id: BOOKING_ID }]);
    const repositoryWithClient = new BookingRepository({
      client: { booking: { findMany } },
    } as never);

    await expect(
      repositoryWithClient.findExpiredPendingBookingIdsWithoutPayment(NOW, limit),
    ).resolves.toEqual([BOOKING_ID]);

    expect(findMany).toHaveBeenCalledWith({
      where: {
        status: BOOKING_PENDING_STATUS,
        expiresAt: { lte: NOW },
        payment: { is: null },
      },
      orderBy: { expiresAt: "asc" },
      take: limit,
      select: { id: true },
    });
  });

  it("expires an owned pending booking only after its hold has ended", async () => {
    const updateMany = jest.fn<(args: unknown) => Promise<{ count: number }>>();
    updateMany.mockResolvedValue({ count: 1 });
    const paymentUpdateMany = jest.fn<(args: unknown) => Promise<{ count: number }>>();
    const tx = {
      booking: { updateMany },
      payment: { updateMany: paymentUpdateMany },
    } as unknown as Prisma.TransactionClient;

    await repository.expirePendingBooking(tx, BOOKING_ID, USER_ID, NOW);

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: BOOKING_ID,
        userId: USER_ID,
        status: BOOKING_PENDING_STATUS,
        expiresAt: { lte: NOW },
      },
      data: {
        status: BOOKING_EXPIRED_STATUS,
      },
    });
    expect(paymentUpdateMany).not.toHaveBeenCalled();
  });

  it("expires the pending booking only after its hold has ended", async () => {
    const updateMany = jest.fn<(args: unknown) => Promise<{ count: number }>>();
    updateMany.mockResolvedValue({ count: 1 });
    const paymentUpdateMany = jest.fn<(args: unknown) => Promise<{ count: number }>>();
    const tx = {
      booking: { updateMany },
      payment: { updateMany: paymentUpdateMany },
    } as unknown as Prisma.TransactionClient;

    await repository.expirePendingBookingPastExpiry(tx, BOOKING_ID, NOW);

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: BOOKING_ID,
        status: BOOKING_PENDING_STATUS,
        expiresAt: { lte: NOW },
      },
      data: {
        status: BOOKING_EXPIRED_STATUS,
      },
    });
    expect(JSON.stringify(updateMany.mock.calls[0]?.[0])).not.toContain("userId");
    expect(paymentUpdateMany).not.toHaveBeenCalled();
  });

  it("cancels an owned pending booking for reconciliation even when the hold has not ended", async () => {
    const updateMany = jest.fn<(args: unknown) => Promise<{ count: number }>>();
    updateMany.mockResolvedValue({ count: 1 });
    const paymentUpdateMany = jest.fn<(args: unknown) => Promise<{ count: number }>>();
    const tx = {
      booking: { updateMany },
      payment: { updateMany: paymentUpdateMany },
    } as unknown as Prisma.TransactionClient;

    await repository.cancelPendingBookingForReconciliation(tx, BOOKING_ID, USER_ID, NOW);

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: BOOKING_ID,
        userId: USER_ID,
        status: BOOKING_PENDING_STATUS,
      },
      data: {
        status: BOOKING_CANCELLED_STATUS,
        cancelledAt: NOW,
      },
    });
    expect(JSON.stringify(updateMany.mock.calls[0]?.[0])).not.toContain("expiresAt");
    expect(paymentUpdateMany).not.toHaveBeenCalled();
  });
});
