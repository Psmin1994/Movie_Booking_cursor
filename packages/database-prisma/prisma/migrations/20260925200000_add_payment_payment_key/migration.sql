-- Existing payments have no Toss paymentKey. Leave them null.
ALTER TABLE "Payment" ADD COLUMN "paymentKey" TEXT;

CREATE UNIQUE INDEX "Payment_paymentKey_key" ON "Payment"("paymentKey");
