import { IsOptional, IsInt, Min, Max, IsString, IsEnum, IsBoolean } from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { EmergencyStatus } from '@prisma/client';

export class EmergenciesQueryDto {
  @ApiPropertyOptional({ enum: EmergencyStatus })
  @IsOptional()
  @IsEnum(EmergencyStatus)
  status?: EmergencyStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  organizationId?: string;

  @ApiPropertyOptional({ description: 'Filter by assigned: true = assigned, false = unassigned' })
  @IsOptional()
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  assigned?: boolean;

  @ApiPropertyOptional({ description: 'From date (ISO string)' })
  @IsOptional()
  @IsString()
  from?: string;

  @ApiPropertyOptional({ description: 'To date (ISO string)' })
  @IsOptional()
  @IsString()
  to?: string;

  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}
