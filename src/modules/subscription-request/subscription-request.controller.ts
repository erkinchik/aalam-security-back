import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CreateSubscriptionRequestDto } from './dto/create-subscription-request.dto';
import { SubscriptionRequestService } from './subscription-request.service';

@ApiTags('Subscription requests')
@ApiBearerAuth()
@Controller('subscription-requests')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.USER)
export class SubscriptionRequestController {
  constructor(
    private readonly subscriptionRequestService: SubscriptionRequestService,
  ) {}

  @Post()
  @ApiOperation({
    summary: 'Submit a new subscription request',
    description:
      'Creates a pending subscription request. While the payment gateway is not connected, requests are approved manually by an admin. Only one PENDING request per user is allowed.',
  })
  create(
    @CurrentUser() user: { id: string },
    @Body() dto: CreateSubscriptionRequestDto,
  ) {
    return this.subscriptionRequestService.create(user.id, dto);
  }

  @Get('me/current')
  @ApiOperation({
    summary: 'Get the current user’s latest subscription request',
    description:
      'Returns the latest PENDING request if any, otherwise the most recent request (APPROVED/REJECTED). Returns null if the user has never submitted a request.',
  })
  getCurrent(@CurrentUser() user: { id: string }) {
    return this.subscriptionRequestService.getCurrentForUser(user.id);
  }
}
