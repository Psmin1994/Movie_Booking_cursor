import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BOOKING_CANCELLED_STATUS,
  isCancelledWithReconciliationRequired,
  PAYMENT_RECONCILIATION_REQUIRED_STATUS,
} from "./reconciliation-required.js";

describe("isCancelledWithReconciliationRequired", () => {
  it("matches cancelled booking with reconciliation-required payment", () => {
    assert.equal(
      isCancelledWithReconciliationRequired(
        BOOKING_CANCELLED_STATUS,
        PAYMENT_RECONCILIATION_REQUIRED_STATUS,
      ),
      true,
    );
  });

  it("does not match a regular cancelled booking", () => {
    assert.equal(isCancelledWithReconciliationRequired(BOOKING_CANCELLED_STATUS, "CANCELED"), false);
    assert.equal(isCancelledWithReconciliationRequired(BOOKING_CANCELLED_STATUS, "FAILED"), false);
    assert.equal(isCancelledWithReconciliationRequired(BOOKING_CANCELLED_STATUS, null), false);
    assert.equal(isCancelledWithReconciliationRequired(BOOKING_CANCELLED_STATUS, undefined), false);
  });

  it("does not match reconciliation-required payment on a non-cancelled booking", () => {
    assert.equal(
      isCancelledWithReconciliationRequired("PENDING", PAYMENT_RECONCILIATION_REQUIRED_STATUS),
      false,
    );
    assert.equal(
      isCancelledWithReconciliationRequired("EXPIRED", PAYMENT_RECONCILIATION_REQUIRED_STATUS),
      false,
    );
  });

  it("does not match paid or failed payment outcomes", () => {
    assert.equal(isCancelledWithReconciliationRequired(BOOKING_CANCELLED_STATUS, "PAID"), false);
    assert.equal(isCancelledWithReconciliationRequired("CONFIRMED", "PAID"), false);
    assert.equal(isCancelledWithReconciliationRequired(BOOKING_CANCELLED_STATUS, "FAILED"), false);
  });
});
