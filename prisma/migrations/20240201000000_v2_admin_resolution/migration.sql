-- AlterEnum
ALTER TYPE "Role" ADD VALUE 'ADMIN';

-- AlterTable
ALTER TABLE "EmergencySession" ADD COLUMN "resolution" TEXT;
