import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
  Matches,
} from 'class-validator';
import {
  KYRGYZ_PHONE_MESSAGE,
  KYRGYZ_PHONE_REGEX,
} from '../../../common/constants/phone';

export class ConfirmTelegramVerificationDto {
  @ApiProperty({ description: 'Verification token issued by /verify/start' })
  @IsString()
  @Length(64, 64)
  token: string;

  @ApiProperty({ example: '+996555123456', description: 'Phone shared by user via Telegram (normalized to +996XXXXXXXXX)' })
  @IsString()
  @Matches(KYRGYZ_PHONE_REGEX, { message: KYRGYZ_PHONE_MESSAGE })
  phone: string;

  @ApiProperty({ description: 'Telegram user ID of the verifier' })
  @IsString()
  @IsNotEmpty()
  telegramId: string;

  @ApiPropertyOptional({ description: 'Telegram username (without @), if set' })
  @IsOptional()
  @IsString()
  telegramUsername?: string;
}
