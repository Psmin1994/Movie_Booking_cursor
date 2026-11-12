-- Legacy Booking.status PAYMENT_UNCERTAIN is retired.
-- Reconciliation entry now writes CANCELLED; Payment.RECONCILIATION_REQUIRED remains the uncertainty signal.
-- Preserve existing cancelledAt. When it is null, use PaymentReconciliation.createdAt from the same
-- historical open transaction. Do not invent CURRENT_TIMESTAMP. Booking has no updatedAt column.

UPDATE "Booking" AS b
SET
  "status" = 'CANCELLED',
  "cancelledAt" = COALESCE(
    b."cancelledAt",
    (
      SELECT pr."createdAt"
      FROM "Payment" AS p
      INNER JOIN "PaymentReconciliation" AS pr ON pr."paymentId" = p."id"
      WHERE p."bookingId" = b."id"
    )
  )
WHERE b."status" = 'PAYMENT_UNCERTAIN';
