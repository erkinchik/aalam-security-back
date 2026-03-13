import { IsString, IsOptional } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class CloseEmergencyDto {
  @ApiPropertyOptional({ example: 'False alarm' })
  @IsOptional()
  @IsString()
  resolution?: string;
}
