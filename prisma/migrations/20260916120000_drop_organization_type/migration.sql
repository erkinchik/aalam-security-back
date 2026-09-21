-- После удаления PERSONAL в enum осталось одно значение BUSINESS, и колонка
-- хранила его в каждой строке — информации она не несла, а проверки вида
-- `type === BUSINESS` были тавтологией. Убираем колонку вместе с типом.
ALTER TABLE "Organization" DROP COLUMN "type";
DROP TYPE "OrganizationType";
