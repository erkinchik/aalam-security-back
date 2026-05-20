import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateSubscriptionRequestDto {
  @ApiPropertyOptional({
    example: 'Предпочитаемый способ оплаты — наличными',
    description: 'Опциональный комментарий пользователя для администратора',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  comment?: string;
}
