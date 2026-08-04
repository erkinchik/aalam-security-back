import { IsString, Matches, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ResetPasswordDto {
  @ApiProperty({ description: 'Reset token from email' })
  @IsString()
  token: string;

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
  newPassword: string;
}
