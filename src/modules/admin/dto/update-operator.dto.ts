import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { emailToLowercaseTransform } from '../../../common/transformers/email.transform';
import {
  KYRGYZ_PHONE_MESSAGE,
  KYRGYZ_PHONE_REGEX,
} from '../../../common/constants/phone';

/** Все поля необязательны: админ правит карточку оператора по частям. */
export class UpdateOperatorDto {
  @ApiPropertyOptional({ example: 'operator@sos-security.com' })
  @IsOptional()
  @Transform(emailToLowercaseTransform)
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({ example: 'Иван Петров' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  displayName?: string;

  @ApiPropertyOptional({ example: '+996555123456' })
  @IsOptional()
  @IsString()
  @Matches(KYRGYZ_PHONE_REGEX, { message: KYRGYZ_PHONE_MESSAGE })
  phone?: string;
}
