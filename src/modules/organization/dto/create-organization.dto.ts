import { IsString, IsEnum, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { OrganizationType } from '@prisma/client';

export class CreateOrganizationDto {
  @ApiProperty({ example: 'My Cafe' })
  @IsString()
  @MinLength(1)
  name: string;

  @ApiProperty({ enum: OrganizationType })
  @IsEnum(OrganizationType)
  type: OrganizationType;
}
