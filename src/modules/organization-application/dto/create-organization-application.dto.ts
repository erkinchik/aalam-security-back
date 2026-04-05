import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsEmail,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import {
  KYRGYZ_PHONE_MESSAGE,
  KYRGYZ_PHONE_REGEX,
} from '../../../common/constants/phone';
import { emailToLowercaseTransform } from '../../../common/transformers/email.transform';
import { OrganizationApplicationAttachmentDto } from './organization-application-attachment.dto';
import { OrganizationApplicationBranchDto } from './organization-application-branch.dto';

export class CreateOrganizationApplicationDto {
  @ApiProperty({ example: 'Acme Corp' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  organizationName: string;

  @ApiProperty({ example: 'Corporate' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  organizationType: string;

  @ApiProperty({ type: [OrganizationApplicationBranchDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => OrganizationApplicationBranchDto)
  branches: OrganizationApplicationBranchDto[];

  @ApiProperty({ example: 'contact@example.com' })
  @Transform(emailToLowercaseTransform)
  @IsEmail()
  contactEmail: string;

  @ApiProperty({ example: '+996555123456' })
  @IsString()
  @Matches(KYRGYZ_PHONE_REGEX, { message: KYRGYZ_PHONE_MESSAGE })
  contactPhone: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;

  @ApiPropertyOptional({ type: [OrganizationApplicationAttachmentDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OrganizationApplicationAttachmentDto)
  attachments?: OrganizationApplicationAttachmentDto[];
}
