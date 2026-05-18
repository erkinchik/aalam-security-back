import { IsString, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RegisterPushTokenDto {
  @ApiProperty({
    example: 'ExponentPushToken[xxxxxx]',
    description: 'Expo push token in the form ExponentPushToken[...]',
  })
  @IsString()
  // SEC-15: reject garbage / FCM-shaped tokens up front so we never send them
  // to Expo (Expo silently 200s on invalid format, then drops the message).
  @Matches(/^ExponentPushToken\[[A-Za-z0-9_-]+\]$/, {
    message: 'pushToken must be in the form ExponentPushToken[...]',
  })
  pushToken: string;
}
