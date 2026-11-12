-- Store the reconciliation start time and remove the automatic attempt cap.
-- The original start can be restored only while nextProcessAt is still the first one-minute slot.
-- Rows whose start time cannot be restored are removed instead of receiving an invented deadline.

ALTER TABLE "PaymentReconciliation" ADD COLUMN "createdAt" TIMESTAMP(3);

UPDATE "PaymentReconciliation"
SET "createdAt" = "nextProcessAt" - INTERVAL '1 minute'
WHERE "automaticAttemptCount" = 0
  AND "nextProcessAt" IS NOT NULL;

DELETE FROM "PaymentReconciliation"
WHERE "createdAt" IS NULL;

ALTER TABLE "PaymentReconciliation" ALTER COLUMN "createdAt" SET NOT NULL;

ALTER TABLE "PaymentReconciliation" DROP COLUMN "automaticAttemptCount";
