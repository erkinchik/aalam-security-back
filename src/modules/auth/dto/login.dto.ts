import { Transform } from 'class-transformer';
import { IsEmail, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { emailToLowercaseTransform } from '../../../common/transformers/email.transform';

export class LoginDto {
  @ApiProperty({ example: 'user@example.com' })
  @Transform(emailToLowercaseTransform)
  @IsEmail({}, { message: 'Некорректный email' })
  email: string;

  @ApiProperty({ example: '123456' })
  @IsString({ message: 'Введите пароль' })
  password: string;
}
