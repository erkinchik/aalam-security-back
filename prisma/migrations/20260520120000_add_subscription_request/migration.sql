-- CreateEnum
CREATE TYPE "SubscriptionRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "SubscriptionRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "comment" TEXT,
    "status" "SubscriptionRequestStatus" NOT NULL DEFAULT 'PENDING',
    "rejectionReason" TEXT,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubscriptionRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SubscriptionRequest_userId_idx" ON "SubscriptionRequest"("userId");

-- CreateIndex
CREATE INDEX "SubscriptionRequest_status_idx" ON "SubscriptionRequest"("status");

-- CreateIndex
CREATE INDEX "SubscriptionRequest_createdAt_idx" ON "SubscriptionRequest"("createdAt");

-- CreateIndex (partial unique: only one PENDING request per user)
CREATE UNIQUE INDEX "SubscriptionRequest_userId_pending_unique"
    ON "SubscriptionRequest"("userId")
    WHERE "status" = 'PENDING';

-- AddForeignKey
ALTER TABLE "SubscriptionRequest" ADD CONSTRAINT "SubscriptionRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
