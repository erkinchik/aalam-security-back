import { Controller, Get, Post, Body, Param, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { VenueService } from './venue.service';
import { CreateVenueDto } from './dto/create-venue.dto';
import { BindVenueDto } from './dto/bind-venue.dto';

@ApiTags('Venue')
@ApiBearerAuth()
@Controller('venue')
@UseGuards(JwtAuthGuard)
export class VenueController {
  constructor(private readonly venueService: VenueService) {}

  @Post('bind')
  @ApiOperation({ summary: 'Bind user to venue by invite code (USER)' })
  bind(@CurrentUser() user: { id: string }, @Body() dto: BindVenueDto) {
    return this.venueService.bindByInviteCode(user.id, dto.inviteCode);
  }

  @Post('organization/:organizationId')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Create a venue for an organization (ADMIN)' })
  create(
    @CurrentUser() user: { id: string; role: string },
    @Param('organizationId') organizationId: string,
    @Body() dto: CreateVenueDto,
  ) {
    return this.venueService.create(
      user.id,
      organizationId,
      dto,
      user.role === Role.ADMIN,
    );
  }

  @Get('organization/:organizationId')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'List venues of an organization (ADMIN)' })
  listByOrganization(
    @CurrentUser() user: { id: string; role: string },
    @Param('organizationId') organizationId: string,
  ) {
    return this.venueService.listByOrganization(
      user.id,
      organizationId,
      user.role === Role.ADMIN,
    );
  }
}
