/**
 * Test Intent:
 * due PENDING Refund를 한 건씩 앞선 Worker가 끝난 뒤에만 처리함을 보장한다.
 * 대상이 없거나 한 건이 실패해도 나머지 대상은 계속 처리한다.
 * NOT_CLAIMED 및 정상 ProcessRefundResult는 오류로 기록하지 않는다.
 * Cron 설정은 Asia/Seoul 기준 매일 09:00·12:00·15:00과 waitForCompletion을 의미한다.
 */

import { jest } from "@jest/globals";
import { Logger } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import {
  PROCESS_REFUND_RESULT,
  PROCESS_REFUND_SCHEDULER_BATCH_LIMIT,
  PROCESS_REFUND_SCHEDULER_CRON,
  PROCESS_REFUND_SCHEDULER_TIMEZONE,
} from "../refund.constants.js";
import { RefundRepository } from "../repository/refund.repository.js";
import { ProcessRefundService } from "../use-case/process-refund.service.js";
import { ProcessRefundScheduler } from "./process-refund.scheduler.js";

const NOW = new Date("2026-11-02T00:00:00.000Z");
const FIRST_REFUND_ID = "550e8400-e29b-41d4-a716-446655440041";
const SECOND_REFUND_ID = "550e8400-e29b-41d4-a716-446655440042";
const THIRD_REFUND_ID = "550e8400-e29b-41d4-a716-446655440043";
const SCHEDULE_CRON_OPTIONS = "SCHEDULE_CRON_OPTIONS";

describe("ProcessRefundScheduler", () => {
  let scheduler: ProcessRefundScheduler;
  let refundRepository: {
    findDueRefundIds: jest.MockedFunction<RefundRepository["findDueRefundIds"]>;
  };
  let processRefundService: {
    execute: jest.MockedFunction<ProcessRefundService["execute"]>;
  };
  let loggerError: jest.SpiedFunction<Logger["error"]>;

  beforeEach(async () => {
    refundRepository = {
      findDueRefundIds: jest.fn<RefundRepository["findDueRefundIds"]>(),
    };
    processRefundService = {
      execute: jest.fn<ProcessRefundService["execute"]>(),
    };
    loggerError = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    jest.spyOn(Date, "now").mockReturnValue(NOW.getTime());

    const moduleRef = await Test.createTestingModule({
      providers: [
        ProcessRefundScheduler,
        { provide: RefundRepository, useValue: refundRepository },
        { provide: ProcessRefundService, useValue: processRefundService },
      ],
    }).compile();

    scheduler = moduleRef.get(ProcessRefundScheduler);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("processes each candidate only after the previous execution settles", async () => {
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const started: string[] = [];

    refundRepository.findDueRefundIds.mockResolvedValue([FIRST_REFUND_ID, SECOND_REFUND_ID]);
    processRefundService.execute.mockImplementation(async (refundId: string) => {
      started.push(refundId);
      if (refundId === FIRST_REFUND_ID) {
        await firstBlocked;
      }
      return { result: PROCESS_REFUND_RESULT.COMPLETED };
    });

    const run = scheduler.processDueRefunds();
    await flush();

    expect(refundRepository.findDueRefundIds).toHaveBeenCalledWith(
      NOW,
      PROCESS_REFUND_SCHEDULER_BATCH_LIMIT,
    );
    expect(started).toEqual([FIRST_REFUND_ID]);

    releaseFirst();
    await run;

    expect(started).toEqual([FIRST_REFUND_ID, SECOND_REFUND_ID]);
    expect(loggerError).not.toHaveBeenCalled();
  });

  it("does not run the worker when there are no due refunds", async () => {
    refundRepository.findDueRefundIds.mockResolvedValue([]);

    await expect(scheduler.processDueRefunds()).resolves.toBeUndefined();

    expect(refundRepository.findDueRefundIds).toHaveBeenCalledWith(
      NOW,
      PROCESS_REFUND_SCHEDULER_BATCH_LIMIT,
    );
    expect(processRefundService.execute).not.toHaveBeenCalled();
    expect(loggerError).not.toHaveBeenCalled();
  });

  it("continues with the next refund when one worker throws", async () => {
    const failure = new Error("worker failed");
    refundRepository.findDueRefundIds.mockResolvedValue([
      FIRST_REFUND_ID,
      SECOND_REFUND_ID,
      THIRD_REFUND_ID,
    ]);
    processRefundService.execute.mockImplementation(async (refundId: string) => {
      if (refundId === SECOND_REFUND_ID) {
        throw failure;
      }
      return { result: PROCESS_REFUND_RESULT.COMPLETED };
    });

    await expect(scheduler.processDueRefunds()).resolves.toBeUndefined();

    expect(processRefundService.execute).toHaveBeenNthCalledWith(1, FIRST_REFUND_ID);
    expect(processRefundService.execute).toHaveBeenNthCalledWith(2, SECOND_REFUND_ID);
    expect(processRefundService.execute).toHaveBeenNthCalledWith(3, THIRD_REFUND_ID);
    expect(loggerError).toHaveBeenCalledTimes(1);
    expect(loggerError).toHaveBeenCalledWith(
      `Failed to process refund ${SECOND_REFUND_ID}`,
      failure.stack,
    );
  });

  it.each([
    PROCESS_REFUND_RESULT.NOT_CLAIMED,
    PROCESS_REFUND_RESULT.PENDING,
    PROCESS_REFUND_RESULT.COMPLETED,
    PROCESS_REFUND_RESULT.FAILED,
    PROCESS_REFUND_RESULT.REVIEWED,
  ] as const)("does not log an error when the worker returns %s", async (result) => {
    refundRepository.findDueRefundIds.mockResolvedValue([FIRST_REFUND_ID]);
    processRefundService.execute.mockResolvedValue({ result });

    await expect(scheduler.processDueRefunds()).resolves.toBeUndefined();

    expect(processRefundService.execute).toHaveBeenCalledWith(FIRST_REFUND_ID);
    expect(loggerError).not.toHaveBeenCalled();
  });

  it("does not release leases itself", async () => {
    refundRepository.findDueRefundIds.mockResolvedValue([FIRST_REFUND_ID]);
    processRefundService.execute.mockResolvedValue({
      result: PROCESS_REFUND_RESULT.PENDING,
    });

    await scheduler.processDueRefunds();

    expect(Object.keys(refundRepository)).toEqual(["findDueRefundIds"]);
  });

  it("configures daily 09:00, 12:00, and 15:00 Asia/Seoul with waitForCompletion", () => {
    const cronMetadata = Reflect.getMetadata(
      SCHEDULE_CRON_OPTIONS,
      ProcessRefundScheduler.prototype.processDueRefunds,
    ) as {
      cronTime: string;
      timeZone?: string;
      waitForCompletion?: boolean;
    };

    expect(PROCESS_REFUND_SCHEDULER_CRON).toBe("0 9,12,15 * * *");
    expect(PROCESS_REFUND_SCHEDULER_TIMEZONE).toBe("Asia/Seoul");
    expect(PROCESS_REFUND_SCHEDULER_BATCH_LIMIT).toBe(100);
    expect(cronMetadata).toEqual({
      cronTime: "0 9,12,15 * * *",
      timeZone: "Asia/Seoul",
      waitForCompletion: true,
    });
  });
});

function flush(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}
