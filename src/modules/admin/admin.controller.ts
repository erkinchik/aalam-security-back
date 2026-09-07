import {
  Controller,
  Post,
  Get,
  Body,
  Delete,
  Param,
  Patch,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { AdminService } from './admin.service';
import { CreateOperatorDto } from './dto/create-operator.dto';
import { SetOperatorShiftDto } from './dto/set-operator-shift.dto';
import { CreateOrganizationDto } from './dto/create-organization.dto';
import { UpdateOrganizationDto } from './dto/update-organization.dto';
import { AddOrganizationMemberDto } from './dto/add-organization-member.dto';
import { UpdateOrganizationMemberDto } from './dto/update-organization-member.dto';
import { EmergenciesQueryDto } from './dto/emergencies-query.dto';
import { AssignEmergencyDto } from './dto/assign-emergency.dto';
import { CloseEmergencyDto } from './dto/close-emergency.dto';
import { OrganizationApplicationsQueryDto } from './dto/organization-applications-query.dto';
import { ApproveOrganizationApplicationDto } from './dto/approve-organization-application.dto';
import { RejectOrganizationApplicationDto } from './dto/reject-organization-application.dto';
import { SubscriptionRequestsQueryDto } from './dto/subscription-requests-query.dto';
import { ApproveSubscriptionRequestDto } from './dto/approve-subscription-request.dto';
import { RejectSubscriptionRequestDto } from './dto/reject-subscription-request.dto';
import { CreateVenueDto } from '../venue/dto/create-venue.dto';
import { UpdateVenueDto } from '../venue/dto/update-venue.dto';

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
  @ApiOperation({
    summary: 'List operators with shift, workload and online status (ADMIN only)',
  })
  getOperators() {
    return this.adminService.getOperators();
  }

  @Post('operators/:id/shift')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Put an operator on/off shift (409 when taking off with open sessions)',
  })
  setOperatorShift(
    @Param('id') id: string,
    @Body() dto: SetOperatorShiftDto,
  ) {
    return this.adminService.setOperatorShift(id, dto.onShift);
  }

  @Get('organizations')
  @ApiOperation({ summary: 'List organizations (ADMIN only)' })
  getOrganizations() {
    return this.adminService.getOrganizations();
  }

  @Get('organizations/:id')
  @ApiOperation({ summary: 'Get organization details with venues + members (ADMIN only)' })
  getOrganizationById(@Param('id') id: string) {
    return this.adminService.getOrganizationById(id);
  }

  @Post('organizations')
  @ApiOperation({ summary: 'Create organization (ADMIN only)' })
  createOrganization(@Body() dto: CreateOrganizationDto) {
    return this.adminService.createOrganization(dto);
  }

  @Patch('organizations/:id')
  @ApiOperation({ summary: 'Update organization name/type (ADMIN only)' })
  updateOrganization(@Param('id') id: string, @Body() dto: UpdateOrganizationDto) {
    return this.adminService.updateOrganization(id, dto);
  }

  @Delete('organizations/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Delete organization (ADMIN only). Members and venues cascade; historical ' +
      'emergencies keep their rows with organizationId = NULL. Rejects if open sessions exist.',
  })
  deleteOrganization(@Param('id') id: string) {
    return this.adminService.deleteOrganization(id);
  }

  @Post('organizations/:orgId/members')
  @ApiOperation({
    summary:
      'Add an existing user to the organization (ADMIN only). Assigning OWNER ' +
      'demotes the previous owner to MANAGER.',
  })
  addOrganizationMember(@Param('orgId') orgId: string, @Body() dto: AddOrganizationMemberDto) {
    return this.adminService.addOrganizationMember(orgId, dto);
  }

  @Patch('organization-members/:id')
  @ApiOperation({
    summary: 'Change member role or venue binding (ADMIN only). Setting OWNER transfers ownership.',
  })
  updateOrganizationMember(@Param('id') id: string, @Body() dto: UpdateOrganizationMemberDto) {
    return this.adminService.updateOrganizationMember(id, dto);
  }

  @Post('organizations/:orgId/venues')
  @ApiOperation({ summary: 'Create venue in an existing organization (ADMIN only)' })
  createVenue(@Param('orgId') orgId: string, @Body() dto: CreateVenueDto) {
    return this.adminService.createVenue(orgId, dto);
  }

  @Patch('venues/:id')
  @ApiOperation({ summary: 'Update venue (ADMIN only)' })
  updateVenue(@Param('id') id: string, @Body() dto: UpdateVenueDto) {
    return this.adminService.updateVenue(id, dto);
  }

  @Delete('venues/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Delete venue (ADMIN only). Historical emergencies and members keep their rows; venueId becomes NULL via SetNull cascade.',
  })
  deleteVenue(@Param('id') id: string) {
    return this.adminService.deleteVenue(id);
  }

  @Delete('organization-members/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Remove an organization member (ADMIN only). Rejects if the member is the OWNER.',
  })
  removeOrganizationMember(@Param('id') id: string) {
    return this.adminService.removeOrganizationMember(id);
  }

  @Get('organization-applications')
  @ApiOperation({ summary: 'List organization applications (ADMIN only)' })
  getOrganizationApplications(@Query() query: OrganizationApplicationsQueryDto) {
    return this.adminService.getOrganizationApplications(query);
  }

  @Get('organization-applications/:id')
  @ApiOperation({ summary: 'Get organization application by ID (ADMIN only)' })
  getOrganizationApplicationById(@Param('id') id: string) {
    return this.adminService.getOrganizationApplicationById(id);
  }

  @Post('organization-applications/:id/approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Approve application: create org, venues, owner membership (ADMIN only)',
  })
  approveOrganizationApplication(
    @Param('id') id: string,
    @Body() dto: ApproveOrganizationApplicationDto,
  ) {
    return this.adminService.approveOrganizationApplication(id, dto);
  }

  @Post('organization-applications/:id/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reject pending application (ADMIN only)' })
  rejectOrganizationApplication(
    @Param('id') id: string,
    @Body() dto: RejectOrganizationApplicationDto,
  ) {
    return this.adminService.rejectOrganizationApplication(id, dto);
  }

  @Post('users/create-operator')
  @ApiOperation({ summary: 'Create a new operator account (ADMIN only)' })
  createOperator(@Body() dto: CreateOperatorDto) {
    return this.adminService.createOperator(dto);
  }

  @Get('subscription-requests')
  @ApiOperation({ summary: 'List subscription requests (ADMIN only)' })
  getSubscriptionRequests(@Query() query: SubscriptionRequestsQueryDto) {
    return this.adminService.getSubscriptionRequests(query);
  }

  @Get('subscription-requests/:id')
  @ApiOperation({ summary: 'Get subscription request by ID (ADMIN only)' })
  getSubscriptionRequestById(@Param('id') id: string) {
    return this.adminService.getSubscriptionRequestById(id);
  }

  @Post('subscription-requests/:id/approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Approve subscription request: activates user subscription until expiresAt (default +30 days) (ADMIN only)',
  })
  approveSubscriptionRequest(
    @CurrentUser() admin: { id: string },
    @Param('id') id: string,
    @Body() dto: ApproveSubscriptionRequestDto,
  ) {
    return this.adminService.approveSubscriptionRequest(id, admin.id, dto);
  }

  @Post('subscription-requests/:id/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reject pending subscription request (ADMIN only)' })
  rejectSubscriptionRequest(
    @Param('id') id: string,
    @Body() dto: RejectSubscriptionRequestDto,
  ) {
    return this.adminService.rejectSubscriptionRequest(id, dto);
  }
}
