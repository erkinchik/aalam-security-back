import { IsEmail, IsEnum, IsOptional, IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { OrgMemberRole } from '@prisma/client';

export class AddOrganizationMemberDto {
  @ApiProperty({ example: 'employee@example.com', description: 'Почта существующего пользователя' })
  @IsEmail({}, { message: 'Укажите корректный email пользователя' })
  email: string;

  @ApiProperty({ enum: OrgMemberRole, example: 'MEMBER' })
  @IsEnum(OrgMemberRole, { message: 'Роль должна быть OWNER, MANAGER, OPERATOR или MEMBER' })
  role: OrgMemberRole;

  @ApiProperty({
    required: false,
    description:
      'Объект, к которому привязан участник. Пусто — доступ ко всей организации ' +
      '(так работают владельцы и менеджеры).',
  })
  @IsOptional()
  @IsUUID(undefined, { message: 'Некорректный идентификатор объекта' })
  venueId?: string;
}
