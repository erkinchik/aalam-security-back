-- Персональных организаций как понятия больше нет: их записи удалены, а
-- регистрация давно перестала их создавать. Postgres не умеет выкидывать
-- значение из enum, поэтому тип пересоздаётся и колонка переводится на новый.
BEGIN;

CREATE TYPE "OrganizationType_new" AS ENUM ('BUSINESS');

ALTER TABLE "Organization" ALTER COLUMN "type" DROP DEFAULT;
ALTER TABLE "Organization"
  ALTER COLUMN "type" TYPE "OrganizationType_new"
  USING ("type"::text::"OrganizationType_new");

ALTER TYPE "OrganizationType" RENAME TO "OrganizationType_old";
ALTER TYPE "OrganizationType_new" RENAME TO "OrganizationType";
DROP TYPE "OrganizationType_old";

ALTER TABLE "Organization" ALTER COLUMN "type" SET DEFAULT 'BUSINESS';

COMMIT;
