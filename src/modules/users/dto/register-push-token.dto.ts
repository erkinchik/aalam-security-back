import { IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RegisterPushTokenDto {
  @ApiProperty({ example: 'ExponentPushToken[xxxxxx]' })
  @IsString()
  pushToken: string;
}
