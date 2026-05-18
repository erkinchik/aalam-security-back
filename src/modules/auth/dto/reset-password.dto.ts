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
  @MinLength(12, { message: 'Password must be at least 12 characters long' })
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).+$/, {
    message:
      'Password must contain a lowercase letter, an uppercase letter, and a digit',
  })
  newPassword: string;
}
