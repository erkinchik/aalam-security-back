-- AlterTable
ALTER TABLE "User" ADD COLUMN "phoneVerifiedAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "telegramId" TEXT;
ALTER TABLE "User" ADD COLUMN "telegramUsername" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "User_telegramId_key" ON "User"("telegramId");
