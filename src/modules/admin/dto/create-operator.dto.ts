import { Transform } from 'class-transformer';
import { IsEmail, IsString, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { emailToLowercaseTransform } from '../../../common/transformers/email.transform';

export class CreateOperatorDto {
  @ApiProperty({ example: 'operator@sos-security.com' })
  @Transform(emailToLowercaseTransform)
  @IsEmail()
  email: string;

  @ApiProperty({ example: '123456', minLength: 6 })
  @IsString()
  @MinLength(6)
  password: string;
}
