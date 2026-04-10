import { Transform } from 'class-transformer';
import { IsString, IsOptional, IsBoolean, IsEmail, IsNotEmpty, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import {
  KYRGYZ_PHONE_MESSAGE,
  KYRGYZ_PHONE_REGEX,
} from '../../../common/constants/phone';
import { emailToLowercaseTransform } from '../../../common/transformers/email.transform';

export class CreateEmergencyContactDto {
  @ApiProperty({ example: 'John Doe' })
  @IsString()
  name: string;

  @ApiProperty({ example: '+996555123456' })
  @IsString()
  @IsNotEmpty()
  @Matches(KYRGYZ_PHONE_REGEX, { message: KYRGYZ_PHONE_MESSAGE })
  phone: string;

  @ApiProperty({ example: 'john@example.com', required: false })
  @IsOptional()
  @Transform(emailToLowercaseTransform)
  @IsEmail()
  email?: string;

  @ApiProperty({ default: false })
  @IsOptional()
  @IsBoolean()
  isTrusted?: boolean;
}
