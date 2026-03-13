import { IsString, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ResetPasswordDto {
  @ApiProperty({ description: 'Reset token from email' })
  @IsString()
  token: string;

  @ApiProperty({ example: 'newpassword123', minLength: 6 })
  @IsString()
  @MinLength(6)
  newPassword: string;
}
