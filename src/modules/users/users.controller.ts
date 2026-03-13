import { Controller, Get, Patch, Body, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UsersService } from './users.service';
import { RegisterPushTokenDto } from './dto/register-push-token.dto';

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

  @Patch('me/push-token')
  @ApiOperation({ summary: 'Register push notification token for SOS alerts' })
  registerPushToken(
    @CurrentUser() user: { id: string },
    @Body() dto: RegisterPushTokenDto,
  ) {
    return this.usersService.registerPushToken(user.id, dto.pushToken);
  }
}
