/**
 * Test Intent:
 * 자동 재시도 간격은 1분이고, 재시도 기한은 시작 시각으로부터 10분이다.
 */

import {
  AUTOMATIC_RETRIEVE_INTERVAL_MS,
  automaticRetryDeadlineAt,
  nextAutomaticProcessAt,
} from "./reconciliation-schedule.js";

const OPENED_AT = new Date("2026-10-14T00:00:00.000Z");
const MINUTE_MS = 60 * 1000;

describe("automatic reconciliation schedule", () => {
  it("uses a one minute automatic retrieve interval", () => {
    expect(AUTOMATIC_RETRIEVE_INTERVAL_MS).toBe(MINUTE_MS);
    expect(nextAutomaticProcessAt(OPENED_AT)).toEqual(new Date(OPENED_AT.getTime() + MINUTE_MS));
  });

  it("sets the automatic retry deadline ten minutes after opening", () => {
    expect(automaticRetryDeadlineAt(OPENED_AT)).toEqual(
      new Date(OPENED_AT.getTime() + 10 * MINUTE_MS),
    );
  });
});
