import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { OrgMemberRole } from '@prisma/client';

export class UpdateOrganizationMemberDto {
  @ApiProperty({ enum: OrgMemberRole, required: false })
  @IsOptional()
  @IsEnum(OrgMemberRole, { message: 'Роль должна быть OWNER, MANAGER, STAFF или MEMBER' })
  role?: OrgMemberRole;

  @ApiProperty({ required: false, nullable: true, description: 'null — отвязать от объекта' })
  @IsOptional()
  @IsUUID(undefined, { message: 'Некорректный идентификатор объекта' })
  venueId?: string | null;
}
