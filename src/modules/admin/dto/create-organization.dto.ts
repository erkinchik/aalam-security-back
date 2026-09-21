import { IsString, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateOrganizationDto {
  @ApiProperty({ example: 'Dodo Pizza' })
  @IsString()
  @MinLength(1)
  name: string;
}
