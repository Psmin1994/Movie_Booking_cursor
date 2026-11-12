/**
 * Test Intent:
 * PostgreSQL CHECK가 transactionKey 존재 시 cancelRequestedAt 존재를 강제한다.
 * Mock이 아닌 실제 DB에서 허용/거부 조합을 검증한다.
 */

import { randomUUID } from "node:crypto";
import { jest } from "@jest/globals";
import { INestApplication } from "@nestjs/common";
import { App } from "supertest/types";
import { Prisma } from "@movie-booking/database-prisma";
import { PrismaService } from "../src/database/prisma.service.js";
import { REFUND_PENDING_STATUS } from "../src/refund/refund.constants.js";
import { createTestApp } from "./helpers/create-test-app.js";

jest.setTimeout(30_000);

describe("Refund transactionKey/cancelRequestedAt CHECK on PostgreSQL", () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  it("documents the check constraint on Refund", async () => {
    const constraints = await prisma.client.$queryRaw<
      Array<{ conname: string; definition: string }>
    >`
      SELECT c.conname, pg_get_constraintdef(c.oid) AS definition
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      WHERE t.relname = 'Refund'
        AND c.contype = 'c'
        AND c.conname = 'Refund_transactionKey_requires_cancelRequestedAt'
    `;

    expect(constraints).toHaveLength(1);
    expect(constraints[0]?.definition).toContain("transactionKey");
    expect(constraints[0]?.definition).toContain("cancelRequestedAt");
  });

  it("allows null transactionKey with or without cancelRequestedAt", async () => {
    const payment = await createPaidCancelledPayment(prisma);
    const withoutTs = await prisma.client.refund.create({
      data: {
        paymentId: payment.id,
        amount: payment.amount,
        status: REFUND_PENDING_STATUS,
        idempotencyKey: randomUUID(),
        paymentKey: payment.paymentKey!,
        cancelReason: "예매 취소",
        cancelRequestedAt: null,
        transactionKey: null,
      },
    });
    expect(withoutTs.transactionKey).toBeNull();
    expect(withoutTs.cancelRequestedAt).toBeNull();

    const withTs = await prisma.client.refund.update({
      where: { id: withoutTs.id },
      data: { cancelRequestedAt: new Date("2026-10-20T00:00:00.000Z") },
    });
    expect(withTs.cancelRequestedAt).not.toBeNull();
    expect(withTs.transactionKey).toBeNull();

    await prisma.client.refund.delete({ where: { id: withoutTs.id } });
    await cleanupPayment(prisma, payment.id);
  });

  it("allows transactionKey only when cancelRequestedAt is set", async () => {
    const payment = await createPaidCancelledPayment(prisma);
    const refund = await prisma.client.refund.create({
      data: {
        paymentId: payment.id,
        amount: payment.amount,
        status: REFUND_PENDING_STATUS,
        idempotencyKey: randomUUID(),
        paymentKey: payment.paymentKey!,
        cancelReason: "예매 취소",
        cancelRequestedAt: new Date("2026-10-20T00:00:00.000Z"),
        transactionKey: null,
      },
    });

    const updated = await prisma.client.refund.update({
      where: { id: refund.id },
      data: { transactionKey: `txn-${randomUUID()}` },
    });
    expect(updated.transactionKey).not.toBeNull();
    expect(updated.cancelRequestedAt).not.toBeNull();

    await prisma.client.refund.delete({ where: { id: refund.id } });
    await cleanupPayment(prisma, payment.id);
  });

  it("rejects transactionKey when cancelRequestedAt is null", async () => {
    const payment = await createPaidCancelledPayment(prisma);
    const refund = await prisma.client.refund.create({
      data: {
        paymentId: payment.id,
        amount: payment.amount,
        status: REFUND_PENDING_STATUS,
        idempotencyKey: randomUUID(),
        paymentKey: payment.paymentKey!,
        cancelReason: "예매 취소",
        cancelRequestedAt: null,
        transactionKey: null,
      },
    });

    await expect(
      prisma.client.refund.update({
        where: { id: refund.id },
        data: { transactionKey: `txn-${randomUUID()}` },
      }),
    ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);

    const stored = await prisma.client.refund.findUniqueOrThrow({
      where: { id: refund.id },
    });
    expect(stored.transactionKey).toBeNull();
    expect(stored.cancelRequestedAt).toBeNull();

    await prisma.client.refund.delete({ where: { id: refund.id } });
    await cleanupPayment(prisma, payment.id);
  });
});

async function createPaidCancelledPayment(prisma: PrismaService) {
  const suffix = randomUUID().slice(0, 8);
  const user = await prisma.client.user.create({
    data: {
      email: `refund-check-${suffix}@example.com`,
      passwordHash: "hash",
      name: "Refund Check",
    },
  });
  const movie = await prisma.client.movie.create({
    data: {
      title: `Refund Check ${suffix}`,
      runtime: 120,
      releaseDate: new Date("2026-01-01"),
    },
  });
  const screen = await prisma.client.screen.create({
    data: {
      number: Math.floor(Math.random() * 1_000_000) + 10_000,
      floor: 1,
      screenType: "2D",
    },
  });
  const screening = await prisma.client.screening.create({
    data: {
      movieId: movie.id,
      screenId: screen.id,
      startAt: new Date(`2099-0${(Math.floor(Math.random() * 8) + 1)}-01T00:00:00.000Z`),
    },
  });
  const booking = await prisma.client.booking.create({
    data: {
      userId: user.id,
      screeningId: screening.id,
      status: "CANCELLED",
      totalAmount: 10_000,
      expiresAt: new Date(Date.now() + 60_000),
      cancelledAt: new Date(),
    },
  });
  return prisma.client.payment.create({
    data: {
      bookingId: booking.id,
      amount: 10_000,
      status: "PAID",
      paymentKey: `pay-${suffix}`,
      orderId: `order-${suffix}`,
      paidAt: new Date(),
    },
  });
}

async function cleanupPayment(prisma: PrismaService, paymentId: string) {
  const payment = await prisma.client.payment.findUniqueOrThrow({
    where: { id: paymentId },
    select: {
      bookingId: true,
      booking: {
        select: {
          userId: true,
          screeningId: true,
          screening: { select: { movieId: true, screenId: true } },
        },
      },
    },
  });

  await prisma.client.payment.delete({ where: { id: paymentId } });
  await prisma.client.booking.delete({ where: { id: payment.bookingId } });
  await prisma.client.screening.delete({ where: { id: payment.booking.screeningId } });
  await prisma.client.screen.delete({ where: { id: payment.booking.screening.screenId } });
  await prisma.client.movie.delete({ where: { id: payment.booking.screening.movieId } });
  await prisma.client.user.delete({ where: { id: payment.booking.userId } });
}
