import { IsOptional, IsUUID } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class StartEmergencyDto {
  @ApiPropertyOptional({ description: 'Venue to raise the alarm from; omitted for a personal SOS' })
  @IsOptional()
  @IsUUID()
  venueId?: string;
}
