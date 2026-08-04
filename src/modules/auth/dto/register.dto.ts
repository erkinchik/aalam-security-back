import { Transform } from 'class-transformer';
import { IsEmail, IsNotEmpty, IsString, Matches, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { emailToLowercaseTransform } from '../../../common/transformers/email.transform';
import {
  KYRGYZ_PHONE_MESSAGE,
  KYRGYZ_PHONE_REGEX,
} from '../../../common/constants/phone';

export class RegisterDto {
  @ApiProperty({ example: 'user@example.com' })
  @Transform(emailToLowercaseTransform)
  @IsEmail({}, { message: 'Некорректный email' })
  email: string;

  @ApiProperty({
    example: 'Strong-Pass-2026',
    minLength: 12,
    description:
      'Password must be at least 12 characters and contain a lowercase letter, an uppercase letter, and a digit.',
  })
  @IsString()
  @MinLength(12, { message: 'Пароль должен быть не короче 12 символов' })
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).+$/, {
    message: 'Пароль должен содержать строчную и заглавную буквы и цифру',
  })
  password: string;

  @ApiProperty({ example: '+996555123456', description: 'Kyrgyzstan +996 + 9 digits' })
  @IsString({ message: 'Укажите номер телефона' })
  @IsNotEmpty({ message: 'Укажите номер телефона' })
  @Matches(KYRGYZ_PHONE_REGEX, { message: KYRGYZ_PHONE_MESSAGE })
  phone: string;
}
