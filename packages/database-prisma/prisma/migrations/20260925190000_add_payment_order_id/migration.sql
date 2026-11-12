-- Existing payments have no PG order id. Backfill a unique value before NOT NULL.
ALTER TABLE "Payment" ADD COLUMN "orderId" TEXT;

UPDATE "Payment"
SET "orderId" = 'ord_' || "id"
WHERE "orderId" IS NULL;

ALTER TABLE "Payment" ALTER COLUMN "orderId" SET NOT NULL;

CREATE UNIQUE INDEX "Payment_orderId_key" ON "Payment"("orderId");
