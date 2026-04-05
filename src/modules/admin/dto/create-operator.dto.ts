import { Transform } from 'class-transformer';
import { IsEmail, IsString, MinLength, IsOptional } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { emailToLowercaseTransform } from '../../../common/transformers/email.transform';

export class CreateOperatorDto {
  @ApiProperty({ example: 'operator@alarm-sos.com' })
  @Transform(emailToLowercaseTransform)
  @IsEmail()
  email: string;

  @ApiProperty({ example: '123456', minLength: 6 })
  @IsString()
  @MinLength(6)
  password: string;

  @ApiProperty({ required: false, description: 'Organization ID; defaults to Default org' })
  @IsOptional()
  @IsString()
  organizationId?: string;
}
