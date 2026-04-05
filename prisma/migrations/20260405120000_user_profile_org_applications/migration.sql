-- CreateEnum
CREATE TYPE "OrganizationApplicationStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "displayName" TEXT,
ADD COLUMN     "phone" TEXT,
ADD COLUMN     "individualSubscriptionActive" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "OrganizationApplication" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationName" TEXT NOT NULL,
    "organizationType" TEXT NOT NULL,
    "branches" JSONB NOT NULL,
    "contactEmail" TEXT NOT NULL,
    "contactPhone" TEXT NOT NULL,
    "description" TEXT,
    "status" "OrganizationApplicationStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizationApplication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizationApplicationAttachment" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER,
    "storageKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrganizationApplicationAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrganizationApplication_userId_idx" ON "OrganizationApplication"("userId");

-- CreateIndex
CREATE INDEX "OrganizationApplication_status_idx" ON "OrganizationApplication"("status");

-- CreateIndex
CREATE INDEX "OrganizationApplicationAttachment_applicationId_idx" ON "OrganizationApplicationAttachment"("applicationId");

-- AddForeignKey
ALTER TABLE "OrganizationApplication" ADD CONSTRAINT "OrganizationApplication_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationApplicationAttachment" ADD CONSTRAINT "OrganizationApplicationAttachment_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "OrganizationApplication"("id") ON DELETE CASCADE ON UPDATE CASCADE;
