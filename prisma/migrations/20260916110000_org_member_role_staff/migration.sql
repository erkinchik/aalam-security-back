-- OrgMemberRole.OPERATOR путался с Role.OPERATOR: первое — сотрудник внутри
-- компании, второе — диспетчер платформы. Переименовываем в STAFF.
-- Postgres умеет переименовывать значение enum начиная с 10-й версии, так что
-- пересоздавать тип не нужно и данные не трогаются.
ALTER TYPE "OrgMemberRole" RENAME VALUE 'OPERATOR' TO 'STAFF';
