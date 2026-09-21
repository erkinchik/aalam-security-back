import { IsString, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class SetOperatorPasswordDto {
  @ApiProperty({ minLength: 8, description: 'Новый пароль оператора' })
  @IsString()
  @MinLength(8)
  password: string;
}
