import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CreateOrganizationApplicationDto } from './dto/create-organization-application.dto';
import { OrganizationApplicationService } from './organization-application.service';

@ApiTags('Organization applications')
@ApiBearerAuth()
@Controller('organization-applications')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.USER)
export class OrganizationApplicationController {
  constructor(
    private readonly organizationApplicationService: OrganizationApplicationService,
  ) {}

  @Post()
  @ApiOperation({
    summary: 'Submit a new organization request',
    description:
      'Creates a pending application with branch data and optional attachment metadata (files are not stored yet).',
  })
  create(
    @CurrentUser() user: { id: string },
    @Body() dto: CreateOrganizationApplicationDto,
  ) {
    return this.organizationApplicationService.create(user.id, dto);
  }
}
