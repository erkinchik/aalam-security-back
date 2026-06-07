import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNumber, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

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

  @ApiPropertyOptional({ example: 42.876543 })
  @IsOptional()
  @IsNumber()
  @Min(-90)
  @Max(90)
  latitude?: number;

  @ApiPropertyOptional({ example: 74.604321 })
  @IsOptional()
  @IsNumber()
  @Min(-180)
  @Max(180)
  longitude?: number;
}
