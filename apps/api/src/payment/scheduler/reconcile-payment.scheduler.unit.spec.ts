/**
 * Test Intent:
 * Leading Sweep → Due 처리 → Trailing Sweep 순서를 보장한다.
 * Due는 최대 동시 5건만 실행하고, 한 건 실패·Leading Sweep 실패가 나머지 Due/Trailing을 막지 않는다.
 * Scheduler Promise는 모든 in-flight 작업이 끝날 때까지 resolve되지 않는다.
 * Cron은 EVERY_MINUTE와 waitForCompletion을 사용한다.
 */

import { jest } from "@jest/globals";
import { Logger } from "@nestjs/common";
import { CronExpression } from "@nestjs/schedule";
import { Test } from "@nestjs/testing";
import { Prisma } from "@movie-booking/database-prisma";
import { PrismaService } from "../../database/prisma.service.js";
import {
  MARK_RECONCILIATION_REVIEW_PAST_DEADLINE_RESULT,
  RECONCILE_PAYMENT_RESULT,
  RECONCILE_PAYMENT_SCHEDULER_CONCURRENCY,
  RECONCILE_PAYMENT_SCHEDULER_DUE_BATCH_LIMIT,
  RECONCILE_PAYMENT_SCHEDULER_SWEEP_BATCH_LIMIT,
} from "../payment.constants.js";
import { ReconcilePaymentRepository } from "../repository/reconcile-payment.repository.js";
import { ReconcilePaymentService } from "../use-case/reconcile-payment.service.js";
import { ReconcilePaymentScheduler } from "./reconcile-payment.scheduler.js";

const NOW = new Date("2026-11-02T12:00:00.000Z");
const FIRST_ID = "550e8400-e29b-41d4-a716-446655440041";
const SECOND_ID = "550e8400-e29b-41d4-a716-446655440042";
const THIRD_ID = "550e8400-e29b-41d4-a716-446655440043";
const FOURTH_ID = "550e8400-e29b-41d4-a716-446655440044";
const FIFTH_ID = "550e8400-e29b-41d4-a716-446655440045";
const SIXTH_ID = "550e8400-e29b-41d4-a716-446655440046";
const TX = { name: "transaction-client" } as unknown as Prisma.TransactionClient;
const SCHEDULE_CRON_OPTIONS = "SCHEDULE_CRON_OPTIONS";

type RunTransaction = (
  callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
) => Promise<unknown>;

describe("ReconcilePaymentScheduler", () => {
  let scheduler: ReconcilePaymentScheduler;
  let reconcilePaymentRepository: {
    findPastDeadlineIds: jest.MockedFunction<
      ReconcilePaymentRepository["findPastDeadlineIds"]
    >;
    findDueIds: jest.MockedFunction<ReconcilePaymentRepository["findDueIds"]>;
    markReviewPastDeadline: jest.MockedFunction<
      ReconcilePaymentRepository["markReviewPastDeadline"]
    >;
  };
  let reconcilePaymentService: {
    execute: jest.MockedFunction<ReconcilePaymentService["execute"]>;
  };
  let transaction: jest.MockedFunction<RunTransaction>;
  let loggerError: jest.SpiedFunction<Logger["error"]>;
  let callOrder: string[];

  beforeEach(async () => {
    callOrder = [];
    reconcilePaymentRepository = {
      findPastDeadlineIds: jest.fn<ReconcilePaymentRepository["findPastDeadlineIds"]>(),
      findDueIds: jest.fn<ReconcilePaymentRepository["findDueIds"]>(),
      markReviewPastDeadline: jest.fn<ReconcilePaymentRepository["markReviewPastDeadline"]>(),
    };
    reconcilePaymentService = {
      execute: jest.fn<ReconcilePaymentService["execute"]>(),
    };
    transaction = jest.fn<RunTransaction>(async (callback) => callback(TX));
    loggerError = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    jest.spyOn(Date, "now").mockReturnValue(NOW.getTime());

    reconcilePaymentRepository.findPastDeadlineIds.mockImplementation(async () => {
      callOrder.push("findPastDeadlineIds");
      return [];
    });
    reconcilePaymentRepository.findDueIds.mockImplementation(async () => {
      callOrder.push("findDueIds");
      return [];
    });
    reconcilePaymentRepository.markReviewPastDeadline.mockResolvedValue({
      result: MARK_RECONCILIATION_REVIEW_PAST_DEADLINE_RESULT.REVIEWED,
    });
    reconcilePaymentService.execute.mockResolvedValue({
      result: RECONCILE_PAYMENT_RESULT.NOT_PAID,
    });

    const moduleRef = await Test.createTestingModule({
      providers: [
        ReconcilePaymentScheduler,
        {
          provide: PrismaService,
          useValue: { client: { $transaction: transaction } },
        },
        { provide: ReconcilePaymentRepository, useValue: reconcilePaymentRepository },
        { provide: ReconcilePaymentService, useValue: reconcilePaymentService },
      ],
    }).compile();

    scheduler = moduleRef.get(ReconcilePaymentScheduler);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("runs leading sweep, due processing, then trailing sweep in order", async () => {
    reconcilePaymentRepository.findPastDeadlineIds
      .mockImplementationOnce(async () => {
        callOrder.push("leading-findPastDeadlineIds");
        return [FIRST_ID];
      })
      .mockImplementationOnce(async () => {
        callOrder.push("trailing-findPastDeadlineIds");
        return [SECOND_ID];
      });
    reconcilePaymentRepository.findDueIds.mockImplementation(async () => {
      callOrder.push("findDueIds");
      return [THIRD_ID];
    });
    reconcilePaymentRepository.markReviewPastDeadline.mockImplementation(async (_tx, id) => {
      callOrder.push(`mark:${id}`);
      return { result: MARK_RECONCILIATION_REVIEW_PAST_DEADLINE_RESULT.REVIEWED };
    });
    reconcilePaymentService.execute.mockImplementation(async (id) => {
      callOrder.push(`execute:${id}`);
      return { result: RECONCILE_PAYMENT_RESULT.NOT_PAID };
    });

    await scheduler.processDueReconciliations();

    expect(callOrder).toEqual([
      "leading-findPastDeadlineIds",
      `mark:${FIRST_ID}`,
      "findDueIds",
      `execute:${THIRD_ID}`,
      "trailing-findPastDeadlineIds",
      `mark:${SECOND_ID}`,
    ]);
    expect(reconcilePaymentRepository.findPastDeadlineIds).toHaveBeenNthCalledWith(
      1,
      NOW,
      RECONCILE_PAYMENT_SCHEDULER_SWEEP_BATCH_LIMIT,
    );
    expect(reconcilePaymentRepository.findDueIds).toHaveBeenCalledWith(
      NOW,
      RECONCILE_PAYMENT_SCHEDULER_DUE_BATCH_LIMIT,
    );
    expect(reconcilePaymentRepository.findPastDeadlineIds).toHaveBeenNthCalledWith(
      2,
      NOW,
      RECONCILE_PAYMENT_SCHEDULER_SWEEP_BATCH_LIMIT,
    );
    expect(reconcilePaymentRepository.markReviewPastDeadline).toHaveBeenCalledWith(
      TX,
      FIRST_ID,
      NOW,
    );
    expect(reconcilePaymentRepository.markReviewPastDeadline).toHaveBeenCalledWith(
      TX,
      SECOND_ID,
      NOW,
    );
  });

  it("keeps at most five executes in flight", async () => {
    const ids = [FIRST_ID, SECOND_ID, THIRD_ID, FOURTH_ID, FIFTH_ID, SIXTH_ID];
    const releaseGates = new Map<string, () => void>();
    let inFlight = 0;
    let maxInFlight = 0;

    reconcilePaymentRepository.findDueIds.mockResolvedValue(ids);
    reconcilePaymentService.execute.mockImplementation(async (reconciliationId) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((resolve) => {
        releaseGates.set(reconciliationId, resolve);
      });
      inFlight -= 1;
      return { result: RECONCILE_PAYMENT_RESULT.UNKNOWN };
    });

    const run = scheduler.processDueReconciliations();
    await flush();

    expect(maxInFlight).toBe(RECONCILE_PAYMENT_SCHEDULER_CONCURRENCY);
    expect(reconcilePaymentService.execute).toHaveBeenCalledTimes(
      RECONCILE_PAYMENT_SCHEDULER_CONCURRENCY,
    );

    for (const id of ids) {
      releaseGates.get(id)?.();
      await flush();
    }

    await run;
    expect(maxInFlight).toBe(RECONCILE_PAYMENT_SCHEDULER_CONCURRENCY);
    expect(reconcilePaymentService.execute).toHaveBeenCalledTimes(ids.length);
  });

  it("continues remaining due work when one execute throws", async () => {
    const failure = new Error("reconcile failed");
    reconcilePaymentRepository.findDueIds.mockResolvedValue([FIRST_ID, SECOND_ID, THIRD_ID]);
    reconcilePaymentService.execute.mockImplementation(async (reconciliationId) => {
      if (reconciliationId === SECOND_ID) {
        throw failure;
      }
      return { result: RECONCILE_PAYMENT_RESULT.NOT_PAID };
    });

    await expect(scheduler.processDueReconciliations()).resolves.toBeUndefined();

    expect(reconcilePaymentService.execute).toHaveBeenCalledWith(FIRST_ID);
    expect(reconcilePaymentService.execute).toHaveBeenCalledWith(SECOND_ID);
    expect(reconcilePaymentService.execute).toHaveBeenCalledWith(THIRD_ID);
    expect(loggerError).toHaveBeenCalledWith(
      `Failed to reconcile payment ${SECOND_ID}`,
      failure.stack,
    );
  });

  it("still processes due ids when leading sweep discovery fails", async () => {
    const failure = new Error("sweep lookup failed");
    reconcilePaymentRepository.findPastDeadlineIds
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce([]);
    reconcilePaymentRepository.findDueIds.mockResolvedValue([FIRST_ID]);

    await expect(scheduler.processDueReconciliations()).resolves.toBeUndefined();

    expect(reconcilePaymentService.execute).toHaveBeenCalledWith(FIRST_ID);
    expect(loggerError).toHaveBeenCalledWith(
      "Failed to find past-deadline reconciliations",
      failure.stack,
    );
    expect(reconcilePaymentRepository.findPastDeadlineIds).toHaveBeenCalledTimes(2);
  });

  it("runs trailing sweep even when due processing throws at discovery", async () => {
    const failure = new Error("due lookup failed");
    reconcilePaymentRepository.findDueIds.mockRejectedValue(failure);
    reconcilePaymentRepository.findPastDeadlineIds
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([FIRST_ID]);

    await expect(scheduler.processDueReconciliations()).resolves.toBeUndefined();

    expect(loggerError).toHaveBeenCalledWith("Failed to process due reconciliations", failure.stack);
    expect(reconcilePaymentRepository.findPastDeadlineIds).toHaveBeenCalledTimes(2);
    expect(reconcilePaymentRepository.markReviewPastDeadline).toHaveBeenCalledWith(
      TX,
      FIRST_ID,
      NOW,
    );
  });

  it("does not resolve until in-flight execute work finishes", async () => {
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let resolved = false;

    reconcilePaymentRepository.findDueIds.mockResolvedValue([FIRST_ID]);
    reconcilePaymentService.execute.mockImplementation(async () => {
      await firstBlocked;
      return { result: RECONCILE_PAYMENT_RESULT.NOT_PAID };
    });

    const run = scheduler.processDueReconciliations().then(() => {
      resolved = true;
    });
    await flush();

    expect(resolved).toBe(false);
    expect(reconcilePaymentService.execute).toHaveBeenCalledWith(FIRST_ID);

    releaseFirst();
    await run;
    expect(resolved).toBe(true);
  });

  it("isolates individual sweep mark failures", async () => {
    const failure = new Error("mark failed");
    reconcilePaymentRepository.findPastDeadlineIds
      .mockResolvedValueOnce([FIRST_ID, SECOND_ID])
      .mockResolvedValueOnce([]);
    reconcilePaymentRepository.markReviewPastDeadline.mockImplementation(async (_tx, id) => {
      if (id === FIRST_ID) {
        throw failure;
      }
      return { result: MARK_RECONCILIATION_REVIEW_PAST_DEADLINE_RESULT.REVIEWED };
    });

    await expect(scheduler.processDueReconciliations()).resolves.toBeUndefined();

    expect(reconcilePaymentRepository.markReviewPastDeadline).toHaveBeenCalledWith(
      TX,
      FIRST_ID,
      NOW,
    );
    expect(reconcilePaymentRepository.markReviewPastDeadline).toHaveBeenCalledWith(
      TX,
      SECOND_ID,
      NOW,
    );
    expect(loggerError).toHaveBeenCalledWith(
      `Failed to mark past-deadline reconciliation ${FIRST_ID}`,
      failure.stack,
    );
  });

  it("configures EVERY_MINUTE with waitForCompletion and the designed batch limits", () => {
    const cronMetadata = Reflect.getMetadata(
      SCHEDULE_CRON_OPTIONS,
      ReconcilePaymentScheduler.prototype.processDueReconciliations,
    ) as {
      cronTime: string | CronExpression;
      waitForCompletion?: boolean;
    };

    expect(RECONCILE_PAYMENT_SCHEDULER_DUE_BATCH_LIMIT).toBe(30);
    expect(RECONCILE_PAYMENT_SCHEDULER_SWEEP_BATCH_LIMIT).toBe(100);
    expect(RECONCILE_PAYMENT_SCHEDULER_CONCURRENCY).toBe(5);
    expect(cronMetadata).toEqual({
      cronTime: CronExpression.EVERY_MINUTE,
      waitForCompletion: true,
    });
  });
});

function flush(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}
