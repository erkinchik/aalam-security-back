import { PartialType } from '@nestjs/swagger';
import { CreateOrganizationDto } from './create-organization.dto';

/** Все поля необязательны: админ правит организацию по частям. */
export class UpdateOrganizationDto extends PartialType(CreateOrganizationDto) {}
