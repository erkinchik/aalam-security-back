import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import {
  KYRGYZ_PHONE_MESSAGE,
  KYRGYZ_PHONE_REGEX,
} from '../../../common/constants/phone';

export class UpdateUserMeDto {
  @ApiPropertyOptional({ description: 'Display name (email cannot be changed here)' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  displayName?: string;

  @ApiProperty({ example: '+996555123456', description: 'Required. Kyrgyzstan format +996 + 9 digits' })
  @IsString()
  @IsNotEmpty()
  @Matches(KYRGYZ_PHONE_REGEX, { message: KYRGYZ_PHONE_MESSAGE })
  phone: string;
}
