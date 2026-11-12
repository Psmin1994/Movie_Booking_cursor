-- AlterTable
ALTER TABLE "Booking" ADD COLUMN "totalAmount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "failedAt" TIMESTAMP(3);

ALTER TABLE "Booking" ALTER COLUMN "totalAmount" DROP DEFAULT;

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN "amount" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "Payment" ALTER COLUMN "amount" DROP DEFAULT;

-- Bookings closed before confirmation were stored as CANCELLED.
-- Confirmed cancellations keep CANCELLED because confirmedAt is set.
UPDATE "Booking"
SET
  "status" = 'FAILED',
  "failedAt" = "cancelledAt",
  "cancelledAt" = NULL
WHERE "status" = 'CANCELLED'
  AND "confirmedAt" IS NULL;

-- Payment CANCELLED meant the payment closed before capture.
UPDATE "Payment"
SET
  "status" = 'FAILED',
  "failedAt" = COALESCE("failedAt", "cancelledAt")
WHERE "status" = 'CANCELLED';

-- AlterTable
ALTER TABLE "Payment" DROP COLUMN "cancelledAt";

-- CreateTable
CREATE TABLE "Refund" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),

    CONSTRAINT "Refund_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
