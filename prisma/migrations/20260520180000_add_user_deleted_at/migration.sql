-- Apple Guideline 5.1.1(v): self-service account deletion (tombstone pattern).
ALTER TABLE "User" ADD COLUMN "deletedAt" TIMESTAMP(3);

CREATE INDEX "User_deletedAt_idx" ON "User"("deletedAt");
