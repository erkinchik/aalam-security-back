import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class OrganizationApplicationBranchDto {
  @ApiProperty({ example: 'Main office' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name: string;

  @ApiProperty({ example: '123 Main St' })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  address: string;
}
