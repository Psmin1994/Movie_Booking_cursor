-- Rename final adjudication column. Values and nullability are preserved.
ALTER TABLE "PaymentReconciliation" RENAME COLUMN "lastResult" TO "result";
