import { IsString, IsOptional, IsBoolean, IsEmail } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateEmergencyContactDto {
  @ApiProperty({ example: 'John Doe' })
  @IsString()
  name: string;

  @ApiProperty({ example: '+1234567890', required: false })
  @IsOptional()
  @IsString()
  phone?: string;

  @ApiProperty({ example: 'john@example.com', required: false })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiProperty({ default: false })
  @IsOptional()
  @IsBoolean()
  isTrusted?: boolean;
}
