import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { AdminService } from './admin.service';
import { CreateOperatorDto } from './dto/create-operator.dto';
import { CreateOrganizationDto } from './dto/create-organization.dto';
import { EmergenciesQueryDto } from './dto/emergencies-query.dto';
import { AssignEmergencyDto } from './dto/assign-emergency.dto';
import { CloseEmergencyDto } from './dto/close-emergency.dto';

@ApiTags('Admin')
@ApiBearerAuth()
@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get('emergencies')
  @ApiOperation({ summary: 'List all emergencies with filters (ADMIN only)' })
  getEmergencies(@Query() query: EmergenciesQueryDto) {
    return this.adminService.getEmergencies(query);
  }

  @Get('emergencies/:id')
  @ApiOperation({ summary: 'Get emergency details by ID (ADMIN only)' })
  getEmergencyById(@Param('id') id: string) {
    return this.adminService.getEmergencyById(id);
  }

  @Post('emergencies/:id/assign')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Assign emergency to operator (ADMIN only)' })
  assignSession(
    @Param('id') id: string,
    @Body() dto: AssignEmergencyDto,
  ) {
    return this.adminService.assignSession(id, dto.operatorId);
  }

  @Post('emergencies/:id/reassign')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reassign emergency to another operator (ADMIN only)' })
  reassignSession(
    @Param('id') id: string,
    @Body() dto: AssignEmergencyDto,
  ) {
    return this.adminService.reassignSession(id, dto.operatorId);
  }

  @Post('emergencies/:id/unassign')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Unassign emergency - return to pool (ADMIN only)' })
  unassignSession(@Param('id') id: string) {
    return this.adminService.unassignSession(id);
  }

  @Post('emergencies/:id/close')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Close emergency without operator (e.g. false alarm)' })
  closeSession(@Param('id') id: string, @Body() dto?: CloseEmergencyDto) {
    return this.adminService.closeSessionAdmin(id, dto?.resolution);
  }

  @Get('operators')
  @ApiOperation({ summary: 'List operators with workload and online status (ADMIN only)' })
  getOperators(@Query('organizationId') organizationId?: string) {
    return this.adminService.getOperators(organizationId);
  }

  @Get('organizations')
  @ApiOperation({ summary: 'List organizations (ADMIN only)' })
  getOrganizations() {
    return this.adminService.getOrganizations();
  }

  @Post('organizations')
  @ApiOperation({ summary: 'Create organization (ADMIN only)' })
  createOrganization(@Body() dto: CreateOrganizationDto) {
    return this.adminService.createOrganization(dto);
  }

  @Post('users/create-operator')
  @ApiOperation({ summary: 'Create a new operator account (ADMIN only)' })
  createOperator(@Body() dto: CreateOperatorDto) {
    return this.adminService.createOperator(dto);
  }
}
