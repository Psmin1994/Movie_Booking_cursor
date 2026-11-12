-- Separate work status from lease fields, and store the latest reconciliation result separately.
-- Existing open rows become SCHEDULED. Rows with completedAt become COMPLETED.
-- lastResult stays NULL because prior results cannot be reconstructed from completedAt alone.

ALTER TABLE "PaymentReconciliation" ADD COLUMN "status" TEXT,
ADD COLUMN "lastResult" TEXT;

UPDATE "PaymentReconciliation"
SET "status" = 'SCHEDULED'
WHERE "completedAt" IS NULL;

UPDATE "PaymentReconciliation"
SET "status" = 'COMPLETED'
WHERE "completedAt" IS NOT NULL;

ALTER TABLE "PaymentReconciliation" ALTER COLUMN "status" SET NOT NULL;
