-- Fixed automatic retry window from reconciliation creation time.
-- Existing rows keep createdAt as the start and receive createdAt + 10 minutes.

ALTER TABLE "PaymentReconciliation" ADD COLUMN "retryDeadline" TIMESTAMP(3);

UPDATE "PaymentReconciliation"
SET "retryDeadline" = "createdAt" + INTERVAL '10 minutes'
WHERE "retryDeadline" IS NULL;

ALTER TABLE "PaymentReconciliation" ALTER COLUMN "retryDeadline" SET NOT NULL;
