-- Invariant: transactionKey implies cancelRequestedAt.
-- Verified no existing rows violate this before applying.

ALTER TABLE "Refund"
ADD CONSTRAINT "Refund_transactionKey_requires_cancelRequestedAt"
CHECK (
  "transactionKey" IS NULL
  OR "cancelRequestedAt" IS NOT NULL
);
