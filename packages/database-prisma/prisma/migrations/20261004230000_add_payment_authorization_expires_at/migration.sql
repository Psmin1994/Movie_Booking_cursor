-- Deadline for an AUTHORIZING payment. Null until authorization starts.
ALTER TABLE "Payment" ADD COLUMN "authorizationExpiresAt" TIMESTAMP(3);
