import { IsOptional, IsInt, Min, Max, IsString, IsEnum, IsBoolean, IsISO8601, Matches } from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { EmergencyStatus } from '@prisma/client';

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

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
  @IsISO8601()
  // ISO допускает и «2026-W01», а new Date() такую строку не понимает — 500.
  @Matches(CALENDAR_DATE, { message: 'from must be a calendar date (YYYY-MM-DD…)' })
  from?: string;

  @ApiPropertyOptional({ description: 'To date (ISO string)' })
  @IsOptional()
  @IsISO8601()
  // ISO допускает и «2026-W01», а new Date() такую строку не понимает — 500.
  @Matches(CALENDAR_DATE, { message: 'to must be a calendar date (YYYY-MM-DD…)' })
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
