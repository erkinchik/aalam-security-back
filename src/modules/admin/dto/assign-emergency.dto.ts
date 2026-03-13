import { IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class AssignEmergencyDto {
  @ApiProperty({ description: 'Operator user ID to assign the call to' })
  @IsString()
  operatorId: string;
}
