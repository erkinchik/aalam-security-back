import { IsNumber, IsPositive } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateLocationDto {
  @ApiProperty({ example: 41.311 })
  @IsNumber()
  latitude: number;

  @ApiProperty({ example: 69.279 })
  @IsNumber()
  longitude: number;

  @ApiProperty({ example: 10.0 })
  @IsNumber()
  @IsPositive()
  accuracy: number;
}
