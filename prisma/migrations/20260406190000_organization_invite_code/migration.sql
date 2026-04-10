-- AlterTable
ALTER TABLE "Organization" ADD COLUMN "inviteCode" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Organization_inviteCode_key" ON "Organization"("inviteCode");
