import {
  Injectable,
  ConflictException,
  UnauthorizedException,
  BadRequestException,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { ConfirmTelegramVerificationDto } from './dto/confirm-telegram-verification.dto';

const RESET_TOKEN_EXPIRY_HOURS = 1;
const BCRYPT_COST = 12;
const PHONE_VERIFY_TTL_SECONDS = 10 * 60; // 10 minutes

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly logger = new Logger(AuthService.name);

  // Pre-hashed dummy password used to equalize bcrypt timing when the email
  // doesn't exist (SEC-13). Computed once at startup.
  private dummyHash = '';

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly redis: RedisService,
  ) {}

  async onModuleInit() {
    this.dummyHash = await bcrypt.hash(
      'placeholder-not-a-real-password',
      BCRYPT_COST,
    );
  }

  async register(dto: RegisterDto) {
    const existing = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });

    if (existing) {
      throw new ConflictException('Email already registered');
    }

    const hashedPassword = await bcrypt.hash(dto.password, BCRYPT_COST);

    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        password: hashedPassword,
        role: 'USER',
        phone: dto.phone,
      },
    });

    // Организацию при регистрации НЕ создаём. Раньше здесь появлялась
    // персональная «My Account» на каждого зарегистрировавшегося, даже если он
    // ни разу не нажимал SOS — таблица организаций замусоривалась, а из-за
    // @@unique([userId]) эта запись ещё и занимала единственный слот членства.
    // Личный вызов прекрасно живёт с organizationId = null.

    return this.generateTokens(user.id, user.role);
  }

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });

    // Always run bcrypt.compare so timing doesn't leak whether the email
    // exists (SEC-13). If user is missing, compare against the dummy hash.
    const hashToCheck = user?.password ?? this.dummyHash;
    const passwordValid = await bcrypt.compare(dto.password, hashToCheck);

    if (!user || !passwordValid || user.deletedAt) {
      // Deleted users are rejected with the same error to avoid leaking that
      // a previously-existing account was deleted.
      throw new UnauthorizedException('Invalid credentials');
    }

    return this.generateTokens(user.id, user.role);
  }

  async refresh(refreshToken: string) {
    let payload: { sub: string; role: string };
    try {
      payload = this.jwtService.verify(refreshToken, {
        secret: this.configService.get<string>('jwt.refreshSecret'),
      });
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const isValid = await this.redis.isRefreshTokenValid(
      payload.sub,
      refreshToken,
    );
    if (!isValid) {
      // JWT is signature-valid but the token is no longer in Redis. The two
      // common causes are (a) a benign race between two browser tabs / the
      // app and a websocket re-handshake refreshing the same token at the
      // same time, and (b) a stolen/replayed refresh token. Previously we
      // burned all sessions of the user here (REL-4), but on a real SOS app
      // that meant any tab race mass-logged the user out — including from
      // mobile during an emergency. Now we just reject this single request.
      // Bounding the damage of (b) still stands: an attacker's window is
      // capped by the access-token TTL (15m) once rotation hands a new pair
      // to the legitimate client.
      this.logger.warn(
        `Refresh-token reuse rejected for user ${payload.sub} (this session must re-login; other sessions kept)`,
      );
      throw new UnauthorizedException('Token revoked');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
    });
    if (!user || user.deletedAt) {
      throw new UnauthorizedException('User not found');
    }

    await this.redis.removeRefreshToken(payload.sub, refreshToken);

    return this.generateTokens(user.id, user.role);
  }

  async logout(userId: string, refreshToken: string) {
    await this.redis.removeRefreshToken(userId, refreshToken);
    return { status: 'ok' };
  }

  async forgotPassword(email: string) {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || user.deletedAt) return { status: 'ok' }; // Don't reveal if email exists / was deleted

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + RESET_TOKEN_EXPIRY_HOURS * 60 * 60 * 1000);
    await this.prisma.passwordResetToken.create({
      data: { userId: user.id, token, expiresAt },
    });

    const appUrl = this.configService.get<string>('app.url') || 'https://app.sos-security.com';
    const resetLink = `${appUrl}/reset-password?token=${token}`;
    // TODO (FEAT-1): integrate SendGrid/Postmark/Mailgun.
    // SEC-11: never log the full token. Print only a short prefix for audit.
    this.logger.log(
      `Password reset requested for ${email} (token prefix: ${token.slice(0, 6)}…)`,
    );
    // resetLink kept as a local — used by future mailer.
    void resetLink;

    return { status: 'ok' };
  }

  async resetPassword(token: string, newPassword: string) {
    const record = await this.prisma.passwordResetToken.findUnique({
      where: { token },
      include: { user: true },
    });
    if (!record || record.expiresAt < new Date()) {
      throw new UnauthorizedException('Invalid or expired reset token');
    }

    const hashedPassword = await bcrypt.hash(newPassword, BCRYPT_COST);
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: record.userId },
        data: { password: hashedPassword },
      }),
      this.prisma.passwordResetToken.delete({ where: { id: record.id } }),
    ]);

    return { status: 'ok' };
  }

  async startTelegramVerification(userId: string) {
    const token = crypto.randomBytes(32).toString('hex');
    await this.redis.setPhoneVerificationToken(
      token,
      userId,
      PHONE_VERIFY_TTL_SECONDS,
    );

    const botUsername = this.configService.get<string>('telegram.botUsername');
    const deepLink = `https://t.me/${botUsername}?start=${token}`;

    return { token, deepLink };
  }

  async confirmTelegramVerification(dto: ConfirmTelegramVerificationDto) {
    const userId = await this.redis.getPhoneVerificationUserId(dto.token);
    if (!userId) {
      throw new BadRequestException('Token expired or invalid');
    }

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      // Token outlived the user account — clean up and reject.
      await this.redis.deletePhoneVerificationToken(dto.token);
      throw new BadRequestException('Token expired or invalid');
    }

    if (user.phone && user.phone !== dto.phone) {
      throw new BadRequestException('Phone mismatch');
    }

    // If telegramId already belongs to another account, refuse — one Telegram
    // account verifies one user.
    const existingTelegramUser = await this.prisma.user.findUnique({
      where: { telegramId: dto.telegramId },
    });
    if (existingTelegramUser && existingTelegramUser.id !== userId) {
      throw new BadRequestException('Telegram account already linked');
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        phone: dto.phone,
        phoneVerifiedAt: new Date(),
        telegramId: dto.telegramId,
        telegramUsername: dto.telegramUsername ?? null,
      },
    });
    await this.redis.deletePhoneVerificationToken(dto.token);

    this.logger.log(`Phone verified via Telegram for user ${userId}`);

    return { success: true };
  }

  private async generateTokens(userId: string, role: string) {
    const payload = { sub: userId, role };

    const accessToken = this.jwtService.sign(payload, {
      secret: this.configService.get<string>('jwt.accessSecret'),
      expiresIn: this.configService.get<string>('jwt.accessExpires'),
    });

    const refreshToken = this.jwtService.sign(payload, {
      secret: this.configService.get<string>('jwt.refreshSecret'),
      expiresIn: this.configService.get<string>('jwt.refreshExpires'),
    });

    const refreshTtlSeconds =
      this.configService.get<number>('jwt.refreshTtlSeconds') ?? 7 * 86400;
    await this.redis.storeRefreshToken(userId, refreshToken, refreshTtlSeconds);

    return { accessToken, refreshToken };
  }
}
