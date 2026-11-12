/**
 * Test Intent:
 * 만료 대상 Payment를 한 건씩 앞선 처리가 끝난 뒤에만 만료함을 보장한다. 대상이 없거나 한 건이 실패해도 나머지 대상은 계속 처리한다.
 */

import { jest } from "@jest/globals";
import { Logger } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { ExpirePaymentScheduler } from "./expire-payment.scheduler.js";
import { ExpirePaymentService } from "../use-case/expire-payment.service.js";
import { EXPIRE_DUE_PAYMENT_RESULT } from "../payment.constants.js";
import { PaymentRepository } from "../repository/payment.repository.js";

const NOW = new Date("2026-10-04T12:00:00.000Z");
const FIRST_PAYMENT_ID = "550e8400-e29b-41d4-a716-446655440031";
const SECOND_PAYMENT_ID = "550e8400-e29b-41d4-a716-446655440032";
const THIRD_PAYMENT_ID = "550e8400-e29b-41d4-a716-446655440033";
const BATCH_LIMIT = 100;

describe("ExpirePaymentScheduler", () => {
  let scheduler: ExpirePaymentScheduler;
  let paymentRepository: {
    findExpiredPendingPaymentIds: jest.MockedFunction<
      PaymentRepository["findExpiredPendingPaymentIds"]
    >;
  };
  let expirePaymentService: {
    execute: jest.MockedFunction<ExpirePaymentService["execute"]>;
  };
  let loggerError: jest.SpiedFunction<Logger["error"]>;

  beforeEach(async () => {
    paymentRepository = {
      findExpiredPendingPaymentIds: jest.fn<PaymentRepository["findExpiredPendingPaymentIds"]>(),
    };
    expirePaymentService = {
      execute: jest.fn<ExpirePaymentService["execute"]>(),
    };
    loggerError = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    jest.spyOn(Date, "now").mockReturnValue(NOW.getTime());

    const moduleRef = await Test.createTestingModule({
      providers: [
        ExpirePaymentScheduler,
        { provide: PaymentRepository, useValue: paymentRepository },
        { provide: ExpirePaymentService, useValue: expirePaymentService },
      ],
    }).compile();

    scheduler = moduleRef.get(ExpirePaymentScheduler);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("expires each candidate only after the previous execution settles", async () => {
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const started: string[] = [];

    paymentRepository.findExpiredPendingPaymentIds.mockResolvedValue([
      FIRST_PAYMENT_ID,
      SECOND_PAYMENT_ID,
    ]);
    expirePaymentService.execute.mockImplementation(async (paymentId: string) => {
      started.push(paymentId);
      if (paymentId === FIRST_PAYMENT_ID) {
        await firstBlocked;
      }
      return { result: EXPIRE_DUE_PAYMENT_RESULT.EXPIRED };
    });

    const run = scheduler.expireDuePayments();
    await flush();

    expect(paymentRepository.findExpiredPendingPaymentIds).toHaveBeenCalledWith(NOW, BATCH_LIMIT);
    expect(started).toEqual([FIRST_PAYMENT_ID]);

    releaseFirst();
    await run;

    expect(started).toEqual([FIRST_PAYMENT_ID, SECOND_PAYMENT_ID]);
    expect(loggerError).not.toHaveBeenCalled();
  });

  it("continues when a candidate is not eligible", async () => {
    paymentRepository.findExpiredPendingPaymentIds.mockResolvedValue([
      FIRST_PAYMENT_ID,
      SECOND_PAYMENT_ID,
    ]);
    expirePaymentService.execute.mockResolvedValue({
      result: EXPIRE_DUE_PAYMENT_RESULT.NOT_ELIGIBLE,
    });

    await expect(scheduler.expireDuePayments()).resolves.toBeUndefined();

    expect(expirePaymentService.execute).toHaveBeenNthCalledWith(1, FIRST_PAYMENT_ID);
    expect(expirePaymentService.execute).toHaveBeenNthCalledWith(2, SECOND_PAYMENT_ID);
    expect(loggerError).not.toHaveBeenCalled();
  });

  it("continues with the next payment when one expiration throws", async () => {
    const failure = new Error("seat release failed");
    paymentRepository.findExpiredPendingPaymentIds.mockResolvedValue([
      FIRST_PAYMENT_ID,
      SECOND_PAYMENT_ID,
      THIRD_PAYMENT_ID,
    ]);
    expirePaymentService.execute.mockImplementation(async (paymentId: string) => {
      if (paymentId === SECOND_PAYMENT_ID) {
        throw failure;
      }
      return { result: EXPIRE_DUE_PAYMENT_RESULT.EXPIRED };
    });

    await expect(scheduler.expireDuePayments()).resolves.toBeUndefined();

    expect(expirePaymentService.execute).toHaveBeenNthCalledWith(1, FIRST_PAYMENT_ID);
    expect(expirePaymentService.execute).toHaveBeenNthCalledWith(2, SECOND_PAYMENT_ID);
    expect(expirePaymentService.execute).toHaveBeenNthCalledWith(3, THIRD_PAYMENT_ID);
    expect(loggerError).toHaveBeenCalledTimes(1);
    expect(loggerError).toHaveBeenCalledWith(
      `Failed to expire payment ${SECOND_PAYMENT_ID}`,
      failure.stack,
    );
  });

  it("finishes without expiring anything when there are no candidates", async () => {
    paymentRepository.findExpiredPendingPaymentIds.mockResolvedValue([]);

    await expect(scheduler.expireDuePayments()).resolves.toBeUndefined();

    expect(expirePaymentService.execute).not.toHaveBeenCalled();
    expect(loggerError).not.toHaveBeenCalled();
  });
});

function flush(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}
