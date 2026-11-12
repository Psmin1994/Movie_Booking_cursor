/**
 * Test Intent:
 * 기한이 지난 AUTHORIZING Payment를 한 건씩 앞선 처리가 끝난 뒤에만 복구함을 보장한다. 대상이 없거나 한 건이 복구 대상이 아니거나 실패해도 나머지 대상은 계속 처리한다.
 */

import { jest } from "@jest/globals";
import { Logger } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { RECOVER_AUTHORIZING_PAYMENT_RESULT } from "../payment.constants.js";
import { PaymentRepository } from "../repository/payment.repository.js";
import { RecoverAuthorizingPaymentService } from "../use-case/recover-authorizing-payment.service.js";
import { RecoverAuthorizingPaymentScheduler } from "./recover-authorizing-payment.scheduler.js";

const NOW = new Date("2026-10-04T12:00:00.000Z");
const FIRST_PAYMENT_ID = "550e8400-e29b-41d4-a716-446655440031";
const SECOND_PAYMENT_ID = "550e8400-e29b-41d4-a716-446655440032";
const THIRD_PAYMENT_ID = "550e8400-e29b-41d4-a716-446655440033";
const BATCH_LIMIT = 100;

describe("RecoverAuthorizingPaymentScheduler", () => {
  let scheduler: RecoverAuthorizingPaymentScheduler;
  let paymentRepository: {
    findAuthorizingPaymentIdsPastDeadline: jest.MockedFunction<
      PaymentRepository["findAuthorizingPaymentIdsPastDeadline"]
    >;
  };
  let recoverAuthorizingPaymentService: {
    execute: jest.MockedFunction<RecoverAuthorizingPaymentService["execute"]>;
  };
  let loggerError: jest.SpiedFunction<Logger["error"]>;

  beforeEach(async () => {
    paymentRepository = {
      findAuthorizingPaymentIdsPastDeadline:
        jest.fn<PaymentRepository["findAuthorizingPaymentIdsPastDeadline"]>(),
    };
    recoverAuthorizingPaymentService = {
      execute: jest.fn<RecoverAuthorizingPaymentService["execute"]>(),
    };
    loggerError = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    jest.spyOn(Date, "now").mockReturnValue(NOW.getTime());

    const moduleRef = await Test.createTestingModule({
      providers: [
        RecoverAuthorizingPaymentScheduler,
        { provide: PaymentRepository, useValue: paymentRepository },
        { provide: RecoverAuthorizingPaymentService, useValue: recoverAuthorizingPaymentService },
      ],
    }).compile();

    scheduler = moduleRef.get(RecoverAuthorizingPaymentScheduler);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("recovers each candidate only after the previous execution settles", async () => {
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const started: string[] = [];

    paymentRepository.findAuthorizingPaymentIdsPastDeadline.mockResolvedValue([
      FIRST_PAYMENT_ID,
      SECOND_PAYMENT_ID,
    ]);
    recoverAuthorizingPaymentService.execute.mockImplementation(async (paymentId: string) => {
      started.push(paymentId);
      if (paymentId === FIRST_PAYMENT_ID) {
        await firstBlocked;
      }
      return { result: RECOVER_AUTHORIZING_PAYMENT_RESULT.RECONCILIATION_REQUIRED };
    });

    const run = scheduler.recoverDueAuthorizingPayments();
    await flush();

    expect(paymentRepository.findAuthorizingPaymentIdsPastDeadline).toHaveBeenCalledWith(
      NOW,
      BATCH_LIMIT,
    );
    expect(started).toEqual([FIRST_PAYMENT_ID]);

    releaseFirst();
    await run;

    expect(started).toEqual([FIRST_PAYMENT_ID, SECOND_PAYMENT_ID]);
    expect(loggerError).not.toHaveBeenCalled();
  });

  it("continues when a candidate is not eligible", async () => {
    paymentRepository.findAuthorizingPaymentIdsPastDeadline.mockResolvedValue([
      FIRST_PAYMENT_ID,
      SECOND_PAYMENT_ID,
    ]);
    recoverAuthorizingPaymentService.execute.mockResolvedValue({
      result: RECOVER_AUTHORIZING_PAYMENT_RESULT.NOT_ELIGIBLE,
    });

    await expect(scheduler.recoverDueAuthorizingPayments()).resolves.toBeUndefined();

    expect(recoverAuthorizingPaymentService.execute).toHaveBeenNthCalledWith(1, FIRST_PAYMENT_ID);
    expect(recoverAuthorizingPaymentService.execute).toHaveBeenNthCalledWith(2, SECOND_PAYMENT_ID);
    expect(loggerError).not.toHaveBeenCalled();
  });

  it("continues with the next payment when one recovery throws", async () => {
    const failure = new Error("seat release failed");
    paymentRepository.findAuthorizingPaymentIdsPastDeadline.mockResolvedValue([
      FIRST_PAYMENT_ID,
      SECOND_PAYMENT_ID,
      THIRD_PAYMENT_ID,
    ]);
    recoverAuthorizingPaymentService.execute.mockImplementation(async (paymentId: string) => {
      if (paymentId === SECOND_PAYMENT_ID) {
        throw failure;
      }
      return { result: RECOVER_AUTHORIZING_PAYMENT_RESULT.RECONCILIATION_REQUIRED };
    });

    await expect(scheduler.recoverDueAuthorizingPayments()).resolves.toBeUndefined();

    expect(recoverAuthorizingPaymentService.execute).toHaveBeenNthCalledWith(1, FIRST_PAYMENT_ID);
    expect(recoverAuthorizingPaymentService.execute).toHaveBeenNthCalledWith(2, SECOND_PAYMENT_ID);
    expect(recoverAuthorizingPaymentService.execute).toHaveBeenNthCalledWith(3, THIRD_PAYMENT_ID);
    expect(loggerError).toHaveBeenCalledTimes(1);
    expect(loggerError).toHaveBeenCalledWith(
      `Failed to recover authorizing payment ${SECOND_PAYMENT_ID}`,
      failure.stack,
    );
  });

  it("finishes without recovering anything when there are no candidates", async () => {
    paymentRepository.findAuthorizingPaymentIdsPastDeadline.mockResolvedValue([]);

    await expect(scheduler.recoverDueAuthorizingPayments()).resolves.toBeUndefined();

    expect(recoverAuthorizingPaymentService.execute).not.toHaveBeenCalled();
    expect(loggerError).not.toHaveBeenCalled();
  });
});

function flush(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}
