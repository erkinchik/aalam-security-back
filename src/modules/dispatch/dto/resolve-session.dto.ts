import { IsString, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ResolveSessionDto {
  @ApiProperty({ example: 'False alarm, premises secure' })
  @IsString()
  @MinLength(1)
  resolution: string;
}
