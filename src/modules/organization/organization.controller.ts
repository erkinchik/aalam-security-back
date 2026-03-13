import { Controller, Get, Post, Body, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { OrganizationService } from './organization.service';
import { CreateOrganizationDto } from './dto/create-organization.dto';

@ApiTags('Organization')
@ApiBearerAuth()
@Controller('organization')
@UseGuards(JwtAuthGuard)
export class OrganizationController {
  constructor(private readonly organizationService: OrganizationService) {}

  @Get('my')
  @ApiOperation({ summary: 'Get my organizations' })
  getMyOrganizations(@CurrentUser() user: { id: string }) {
    return this.organizationService.getMyOrganizations(user.id);
  }

  @Post()
  @ApiOperation({ summary: 'Create a new organization (business)' })
  create(
    @CurrentUser() user: { id: string },
    @Body() dto: CreateOrganizationDto,
  ) {
    return this.organizationService.create(user.id, dto);
  }
}
