import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

export class SetOperatorShiftDto {
  @ApiProperty({ example: false, description: 'Whether the operator is on shift' })
  @IsBoolean()
  onShift: boolean;
}
