import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsISO8601, IsOptional } from 'class-validator';

export class ApproveSubscriptionRequestDto {
  @ApiPropertyOptional({
    description:
      'Subscription expiry date in ISO 8601 format. Defaults to (now + 30 days) if not provided.',
    example: '2026-12-31T23:59:59.000Z',
  })
  @IsOptional()
  @IsISO8601()
  expiresAt?: string;
}
