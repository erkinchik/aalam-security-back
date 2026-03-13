import { IsString, IsEnum, MinLength, IsOptional } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { OrganizationType } from '@prisma/client';

export class CreateOrganizationDto {
  @ApiProperty({ example: 'Dodo Pizza' })
  @IsString()
  @MinLength(1)
  name: string;

  @ApiProperty({ enum: OrganizationType, required: false })
  @IsOptional()
  @IsEnum(OrganizationType)
  type?: OrganizationType;
}
