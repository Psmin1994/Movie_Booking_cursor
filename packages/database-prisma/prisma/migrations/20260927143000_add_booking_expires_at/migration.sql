-- AlterTable
ALTER TABLE "Booking" ADD COLUMN "expiresAt" TIMESTAMP(3);

UPDATE "Booking"
SET "expiresAt" = "createdAt" + INTERVAL '10 minutes'
WHERE "expiresAt" IS NULL;

ALTER TABLE "Booking" ALTER COLUMN "expiresAt" SET NOT NULL;
