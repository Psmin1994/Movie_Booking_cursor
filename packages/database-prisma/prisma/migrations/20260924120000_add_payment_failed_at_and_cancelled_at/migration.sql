-- AlterTable
ALTER TABLE "Payment" ADD COLUMN "failedAt" TIMESTAMP(3),
ADD COLUMN "cancelledAt" TIMESTAMP(3);
