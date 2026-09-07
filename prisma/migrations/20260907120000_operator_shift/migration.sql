-- Operator shift: a fresh SOS is broadcast only to operators currently on shift.
-- AlterTable
ALTER TABLE "User" ADD COLUMN "onShift" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN "shiftStartedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "User_role_onShift_idx" ON "User"("role", "onShift");

-- Backs getActiveSessions / getOperatorHistory / the stale-assignment cron,
-- all of which filter by assignedOperatorId.
CREATE INDEX "EmergencySession_assignedOperatorId_idx" ON "EmergencySession"("assignedOperatorId");
