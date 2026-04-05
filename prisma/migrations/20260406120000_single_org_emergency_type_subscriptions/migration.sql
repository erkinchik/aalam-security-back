-- CreateEnum
CREATE TYPE "EmergencyType" AS ENUM ('PERSONAL', 'VENUE');

-- AlterTable User
ALTER TABLE "User" ADD COLUMN     "subscriptionExpiresAt" TIMESTAMP(3),
ADD COLUMN     "planId" TEXT;

-- AlterTable EmergencySession
ALTER TABLE "EmergencySession" ADD COLUMN     "emergencyType" "EmergencyType" NOT NULL DEFAULT 'PERSONAL';

-- Deduplicate OrganizationMember: one row per userId (keep best row per user)
-- Priority: OWNER > MANAGER > OPERATOR > MEMBER, then newest createdAt
DELETE FROM "OrganizationMember" om
WHERE om."id" IN (
  SELECT id FROM (
    SELECT id,
      ROW_NUMBER() OVER (
        PARTITION BY "userId"
        ORDER BY
          CASE role
            WHEN 'OWNER' THEN 1
            WHEN 'MANAGER' THEN 2
            WHEN 'OPERATOR' THEN 3
            WHEN 'MEMBER' THEN 4
            ELSE 5
          END ASC,
          "createdAt" DESC
      ) AS rn
    FROM "OrganizationMember"
  ) ranked
  WHERE ranked.rn > 1
);

-- Drop old composite unique
DROP INDEX IF EXISTS "OrganizationMember_userId_organizationId_key";

-- Enforce single organization membership per user
CREATE UNIQUE INDEX "OrganizationMember_userId_key" ON "OrganizationMember"("userId");
