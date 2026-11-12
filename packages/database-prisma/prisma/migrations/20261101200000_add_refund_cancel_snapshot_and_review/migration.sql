-- Refund cancel request snapshots for idempotent PG recovery.
-- One refund per payment. Historical COMPLETED rows keep null transactionKey
-- because prior PG transaction keys cannot be reconstructed.

ALTER TABLE "Refund" ADD COLUMN "idempotencyKey" TEXT,
ADD COLUMN "paymentKey" TEXT,
ADD COLUMN "cancelReason" TEXT,
ADD COLUMN "cancelRequestedAt" TIMESTAMP(3),
ADD COLUMN "transactionKey" TEXT;

UPDATE "Refund" AS r
SET
  "paymentKey" = p."paymentKey",
  "cancelReason" = '예매 취소',
  "idempotencyKey" = gen_random_uuid()::text
FROM "Payment" AS p
WHERE p."id" = r."paymentId"
  AND p."paymentKey" IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "Refund"
    WHERE "paymentKey" IS NULL
       OR "cancelReason" IS NULL
       OR "idempotencyKey" IS NULL
  ) THEN
    RAISE EXCEPTION 'Refund snapshot backfill failed: paymentKey/cancelReason/idempotencyKey still null';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "Refund"
    GROUP BY "paymentId"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Refund paymentId unique cannot be applied: duplicate refunds exist for a payment';
  END IF;
END $$;

ALTER TABLE "Refund" ALTER COLUMN "idempotencyKey" SET NOT NULL,
ALTER COLUMN "paymentKey" SET NOT NULL,
ALTER COLUMN "cancelReason" SET NOT NULL;

CREATE UNIQUE INDEX "Refund_paymentId_key" ON "Refund"("paymentId");
CREATE UNIQUE INDEX "Refund_idempotencyKey_key" ON "Refund"("idempotencyKey");
CREATE UNIQUE INDEX "Refund_transactionKey_key" ON "Refund"("transactionKey");
