import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, MaxLength, Min, MinLength } from 'class-validator';

export class OrganizationApplicationAttachmentDto {
  @ApiProperty({ example: 'letter.pdf' })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  fileName: string;

  @ApiProperty({ example: 'application/pdf' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  mimeType: string;

  @ApiPropertyOptional({ example: 1024000 })
  @IsOptional()
  @IsInt()
  @Min(0)
  sizeBytes?: number;
}
