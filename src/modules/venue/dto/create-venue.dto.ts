import { IsString, IsOptional, IsNumber, MaxLength, Min, Max } from 'class-validator';
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

  // Координаты обязательны при СОЗДАНИИ объекта: именно по ним группа выезжает
  // на тревогу сотрудника — приложение в этом случае вообще не запрашивает GPS
  // телефона. Объект без координат означал бы вызов без адреса, и выяснилось бы
  // это в худший момент. UpdateVenueDto наследуется через PartialType, поэтому
  // при редактировании поля остаются необязательными и старые объекты без
  // координат можно дозаполнить.
  @ApiProperty({ example: 42.876543, description: 'Широта. Обязательна: по ней выезжает группа.' })
  @IsNumber({}, { message: 'Укажите широту объекта: число от -90 до 90' })
  @Min(-90, { message: 'Укажите широту объекта: число от -90 до 90' })
  @Max(90, { message: 'Укажите широту объекта: число от -90 до 90' })
  latitude: number;

  @ApiProperty({ example: 74.604321, description: 'Долгота. Обязательна: по ней выезжает группа.' })
  @IsNumber({}, { message: 'Укажите долготу объекта: число от -180 до 180' })
  @Min(-180, { message: 'Укажите долготу объекта: число от -180 до 180' })
  @Max(180, { message: 'Укажите долготу объекта: число от -180 до 180' })
  longitude: number;
}
