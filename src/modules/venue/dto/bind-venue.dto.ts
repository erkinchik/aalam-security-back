import { IsString, Length } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class BindVenueDto {
  @ApiProperty({ example: 'ABC123', minLength: 6, maxLength: 6 })
  @IsString()
  @Length(6, 6)
  inviteCode: string;
}
