import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UsersService } from './users.service';
import { RegisterPushTokenDto } from './dto/register-push-token.dto';
import { UpdateUserMeDto } from './dto/update-user-me.dto';

@ApiTags('Users')
@ApiBearerAuth()
@Controller('users')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('me')
  @ApiOperation({ summary: 'Get current user profile' })
  getMe(@CurrentUser() user: { id: string }) {
    return this.usersService.findMe(user.id);
  }

  @Patch('me')
  @ApiOperation({
    summary: 'Update current user profile',
    description:
      'Email cannot be changed here. Subscription state is not accepted on this endpoint.',
  })
  updateMe(
    @CurrentUser() user: { id: string },
    @Body() dto: UpdateUserMeDto,
  ) {
    return this.usersService.updateMe(user.id, dto);
  }

  @Post('me/subscription/demo-activate')
  @HttpCode(HttpStatus.OK)
  @UseGuards(RolesGuard)
  @Roles(Role.USER)
  @ApiOperation({
    summary: 'Demo: activate individual SOS subscription',
    description:
      'Sets individualSubscriptionActive for the current user. Intended for demos only; production should use internal billing webhooks.',
  })
  demoActivateSubscription(@CurrentUser() user: { id: string }) {
    return this.usersService.activateDemoIndividualSubscription(user.id);
  }

  @Delete('me')
  @HttpCode(HttpStatus.OK)
  @UseGuards(RolesGuard)
  @Roles(Role.USER)
  @ApiOperation({
    summary: 'Permanently delete the current user account (Apple 5.1.1(v))',
    description:
      'Anonymizes all PII, revokes refresh tokens and removes pending requests/memberships. Historical emergency sessions are kept for audit but de-linked from PII. Operation is irreversible. Blocked if the user has an active SOS session or non-USER role.',
  })
  deleteMe(@CurrentUser() user: { id: string }) {
    return this.usersService.deleteAccount(user.id);
  }

  @Patch('me/push-token')
  @ApiOperation({ summary: 'Register push notification token for SOS alerts' })
  registerPushToken(
    @CurrentUser() user: { id: string },
    @Body() dto: RegisterPushTokenDto,
  ) {
    return this.usersService.registerPushToken(user.id, dto.pushToken);
  }
}
