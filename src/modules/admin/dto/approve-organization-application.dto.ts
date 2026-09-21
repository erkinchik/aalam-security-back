import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class ApproveOrganizationApplicationDto {
  @ApiPropertyOptional({
    description: 'Override organization name (default: from application)',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  organizationName?: string;
}
