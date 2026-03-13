-- AlterTable: Add inviteCode to Venue (nullable first for existing rows, then backfill and make required)
ALTER TABLE "Venue" ADD COLUMN "inviteCode" TEXT;

-- Generate unique codes for existing venues (LEGACY + row number for uniqueness)
WITH numbered AS (
  SELECT id, 'LEG' || LPAD((ROW_NUMBER() OVER ())::text, 3, '0') AS code
  FROM "Venue" WHERE "inviteCode" IS NULL
)
UPDATE "Venue" v SET "inviteCode" = n.code FROM numbered n WHERE v.id = n.id;

-- Make NOT NULL and add unique constraint
ALTER TABLE "Venue" ALTER COLUMN "inviteCode" SET NOT NULL;
CREATE UNIQUE INDEX "Venue_inviteCode_key" ON "Venue"("inviteCode");
