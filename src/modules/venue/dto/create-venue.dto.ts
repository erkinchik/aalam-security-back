import { IsString, IsOptional, IsNumber, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateVenueDto {
  @ApiProperty({ example: 'Main Hall' })
  @IsString()
  @MaxLength(200)
  name: string;

  @ApiProperty({ example: 'ул. Примерная, 1', required: false, description: 'Базовая строка адреса (улица, дом)' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  address?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  apartment?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  floor?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  entrance?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  doorCode?: string;

  @ApiProperty({ required: false, description: 'Комментарий к адресу (ориентир у входа)' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  addressNotes?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  latitude?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  longitude?: number;
}
