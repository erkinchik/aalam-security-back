import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class RejectSubscriptionRequestDto {
  @ApiPropertyOptional({
    description: 'Optional reason shown to the user',
    maxLength: 2000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  rejectionReason?: string;
}
