import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EmergencyStatus, Prisma, Role } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { UpdateUserMeDto } from './dto/update-user-me.dto';

const ANONYMIZE_EMAIL_DOMAIN = 'deleted.local';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async findMe(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        role: true,
        displayName: true,
        phone: true,
        phoneVerifiedAt: true,
        telegramId: true,
        telegramUsername: true,
        individualSubscriptionActive: true,
        subscriptionExpiresAt: true,
        planId: true,
        createdAt: true,
      },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return user;
  }

  async updateMe(userId: string, dto: UpdateUserMeDto) {
    const data: Prisma.UserUpdateInput = {};
    if (dto.displayName !== undefined) {
      data.displayName = dto.displayName;
    }
    data.phone = dto.phone;

    if (Object.keys(data).length === 0) {
      return this.findMe(userId);
    }

    await this.prisma.user.update({
      where: { id: userId },
      data,
    });

    return this.findMe(userId);
  }

  /** Demo / pre-payment: not exposed on generic PATCH /users/me. Replace with webhook-driven updates. */
  async activateDemoIndividualSubscription(userId: string) {
    await this.prisma.user.update({
      where: { id: userId },
      data: { individualSubscriptionActive: true },
    });
    return this.findMe(userId);
  }

  async registerPushToken(userId: string, pushToken: string) {
    await this.prisma.user.update({
      where: { id: userId },
      data: { pushToken },
    });
    return { status: 'ok' };
  }

  /**
   * Apple Guideline 5.1.1(v): self-service account deletion. Anonymize rather
   * than hard-delete the row, because EmergencySession rows have legal/audit
   * value for an SOS app. After this runs:
   *   - all PII fields are wiped, password is randomized, deletedAt is set
   *   - related cascading rows (memberships, contacts, applications, etc.) are
   *     removed via Prisma onDelete: Cascade — we just trigger the cascade by
   *     deleting the orgMembership / contacts explicitly
   *   - the email is freed (anonymized to deleted_<id>@deleted.local) so the
   *     same address can be used for a new sign-up later
   *   - all refresh tokens are revoked → existing sessions cannot refresh
   */
  async deleteAccount(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true, deletedAt: true },
    });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    if (user.deletedAt) {
      // Idempotent — already deleted, treat as success.
      return { status: 'ok' };
    }
    if (user.role !== Role.USER) {
      throw new ForbiddenException(
        'Сотрудники и администраторы не могут удалить учётную запись самостоятельно. Обратитесь к администратору.',
      );
    }

    const activeEmergency = await this.prisma.emergencySession.findFirst({
      where: {
        userId,
        status: {
          in: [
            EmergencyStatus.NEW,
            EmergencyStatus.ASSIGNED,
            EmergencyStatus.IN_PROGRESS,
          ],
        },
      },
      select: { id: true },
    });
    if (activeEmergency) {
      throw new ConflictException(
        'У вас есть активный SOS-вызов. Дождитесь его завершения и попробуйте снова.',
      );
    }

    const anonymizedEmail = `deleted_${userId}@${ANONYMIZE_EMAIL_DOMAIN}`;
    const randomPassword = await bcrypt.hash(
      crypto.randomBytes(32).toString('hex'),
      10,
    );
    const now = new Date();

    await this.prisma.$transaction(async (tx) => {
      // Cascade-friendly rows we explicitly clean up. Most are already cascade
      // on User delete, but we keep User row → trigger manually.
      await tx.organizationMember.deleteMany({ where: { userId } });
      await tx.emergencyContact.deleteMany({ where: { userId } });
      await tx.passwordResetToken.deleteMany({ where: { userId } });
      await tx.organizationApplication.deleteMany({
        where: { userId, status: 'PENDING' },
      });
      await tx.subscriptionRequest.deleteMany({
        where: { userId, status: 'PENDING' },
      });

      await tx.user.update({
        where: { id: userId },
        data: {
          email: anonymizedEmail,
          password: randomPassword,
          displayName: null,
          phone: null,
          phoneVerifiedAt: null,
          pushToken: null,
          telegramId: null,
          telegramUsername: null,
          individualSubscriptionActive: false,
          subscriptionExpiresAt: null,
          planId: null,
          deletedAt: now,
        },
      });
    });

    // Revoke every refresh token so existing sessions can't be refreshed.
    // Access tokens (15 min) will die on their own.
    await this.redis.removeAllRefreshTokens(userId);

    this.logger.log(`User ${userId} self-deleted account at ${now.toISOString()}`);
    return { status: 'ok' };
  }

}
