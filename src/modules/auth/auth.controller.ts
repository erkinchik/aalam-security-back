import {
  Controller,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { ConfirmTelegramVerificationDto } from './dto/confirm-telegram-verification.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { LoginThrottlerGuard } from '../../common/guards/login-throttler.guard';
import { SharedSecretGuard } from '../../common/guards/shared-secret.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // SEC-6: prevent enumeration / spam by hitting forgot-password repeatedly.
  @Throttle({ default: { limit: 5, ttl: 900_000 } })
  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Request password reset email' })
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.forgotPassword(dto.email);
  }

  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reset password with token' })
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto.token, dto.newPassword);
  }

  @Post('register')
  @ApiOperation({ summary: 'Register a new user' })
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  // SEC-6: 5 attempts per 15 min, keyed by IP+email (via LoginThrottlerGuard).
  @UseGuards(LoginThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 900_000 } })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Login with email and password' })
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  // SEC-6: refresh is keyed by IP only (token itself is the secret).
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Refresh access token' })
  refresh(@Body() dto: RefreshDto) {
    return this.authService.refresh(dto.refreshToken);
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Logout and revoke refresh token' })
  logout(
    @CurrentUser() user: { id: string },
    @Body() dto: RefreshDto,
  ) {
    return this.authService.logout(user.id, dto.refreshToken);
  }

  // Throttled because each call burns a random token + Redis write.
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @Post('telegram/verify/start')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Issue a token + t.me deep-link for phone verification via Telegram bot' })
  startTelegramVerification(@CurrentUser() user: { id: string }) {
    return this.authService.startTelegramVerification(user.id);
  }

  // Called server-to-server by the Telegram bot once the user has shared
  // their contact. Authenticated via X-Bot-Secret header (SharedSecretGuard).
  @Post('telegram/verify/confirm')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SharedSecretGuard)
  @ApiOperation({ summary: 'Bot callback: confirm phone verification' })
  confirmTelegramVerification(@Body() dto: ConfirmTelegramVerificationDto) {
    return this.authService.confirmTelegramVerification(dto);
  }
}
