-- Worker lease fields for internal refund processing.
-- Existing refund rows keep null leases and unchanged domain status/transactionKey.

ALTER TABLE "Refund" ADD COLUMN "leaseToken" TEXT,
ADD COLUMN "leaseUntil" TIMESTAMP(3);

CREATE INDEX "Refund_status_createdAt_idx" ON "Refund"("status", "createdAt");
