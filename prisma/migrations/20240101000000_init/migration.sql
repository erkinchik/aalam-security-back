-- CreateEnum
CREATE TYPE "Role" AS ENUM ('USER', 'OPERATOR');

-- CreateEnum
CREATE TYPE "EmergencyStatus" AS ENUM ('NEW', 'ASSIGNED', 'IN_PROGRESS', 'CLOSED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'USER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmergencySession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "EmergencyStatus" NOT NULL DEFAULT 'NEW',
    "assignedOperatorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "EmergencySession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmergencyLocation" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "accuracy" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmergencyLocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "EmergencySession_status_idx" ON "EmergencySession"("status");

-- CreateIndex
CREATE INDEX "EmergencySession_createdAt_idx" ON "EmergencySession"("createdAt");

-- CreateIndex
CREATE INDEX "EmergencyLocation_sessionId_idx" ON "EmergencyLocation"("sessionId");

-- AddForeignKey
ALTER TABLE "EmergencySession" ADD CONSTRAINT "EmergencySession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmergencySession" ADD CONSTRAINT "EmergencySession_assignedOperatorId_fkey" FOREIGN KEY ("assignedOperatorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmergencyLocation" ADD CONSTRAINT "EmergencyLocation_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "EmergencySession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
