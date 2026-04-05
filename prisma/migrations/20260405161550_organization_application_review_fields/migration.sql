-- AlterTable
ALTER TABLE "OrganizationApplication" ADD COLUMN     "approvedOrganizationId" TEXT,
ADD COLUMN     "rejectionReason" TEXT;

-- CreateIndex
CREATE INDEX "OrganizationApplication_approvedOrganizationId_idx" ON "OrganizationApplication"("approvedOrganizationId");

-- AddForeignKey
ALTER TABLE "OrganizationApplication" ADD CONSTRAINT "OrganizationApplication_approvedOrganizationId_fkey" FOREIGN KEY ("approvedOrganizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;
