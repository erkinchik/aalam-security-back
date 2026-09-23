import {
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EmergencyStatus, Prisma, Role } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { RefreshTokenService } from '../refresh-token/refresh-token.service';
import { UpdateUserMeDto } from './dto/update-user-me.dto';
import { ErrorCode } from '../../common/errors/error-codes';
import { conflict, forbidden } from '../../common/errors/app.exception';
import { anonymizedEmailFor } from '../../common/constants/anonymize';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly refreshTokens: RefreshTokenService,
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
    // Подтверждение относится к конкретному номеру. Сменил номер — отметка
    // больше ничего не доказывает. Телефон приходит в каждом PATCH, поэтому
    // сравниваем, иначе правка одного имени сбрасывала бы верификацию.
    const current = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { phone: true },
    });
    if (current && current.phone !== dto.phone) {
      data.phoneVerifiedAt = null;
    }

    if (Object.keys(data).length === 0) {
      return this.findMe(userId);
    }

    await this.prisma.user.update({
      where: { id: userId },
      data,
    });

    return this.findMe(userId);
  }

  /**
   * Демо-активация подписки. В проде закрыта: иначе любой, кто зарегистрировался,
   * одним запросом выдаёт себе платный доступ. Настоящая активация приходит от
   * биллинга через админский разбор заявки (admin.approveSubscriptionRequest).
   */
  async activateDemoIndividualSubscription(userId: string) {
    if (this.config.get<string>('nodeEnv') === 'production') {
      throw forbidden(
        ErrorCode.DEMO_DISABLED,
        'Demo subscription activation is disabled in production',
      );
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: { individualSubscriptionActive: true },
    });
    return this.findMe(userId);
  }

  /**
   * Один физический телефон — один владелец токена. Поле не уникально, поэтому
   * без явной чистки после смены оператора на устройстве токен оставался бы
   * сразу у двоих, и SOS приходил бы за обоих.
   */
  async registerPushToken(userId: string, pushToken: string) {
    await this.prisma.$transaction([
      this.prisma.user.updateMany({
        where: { pushToken, NOT: { id: userId } },
        data: { pushToken: null },
      }),
      this.prisma.user.update({
        where: { id: userId },
        data: { pushToken },
      }),
    ]);
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
      throw forbidden(
        ErrorCode.STAFF_CANNOT_SELF_DELETE,
        'Staff and admins cannot delete their own account',
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
      throw conflict(
        ErrorCode.ACTIVE_SOS_BLOCKS_DELETE,
        'Account has an active SOS session',
      );
    }

    const anonymizedEmail = anonymizedEmailFor(userId);
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
    await this.refreshTokens.removeAllForUser(userId);

    this.logger.log(`User ${userId} self-deleted account at ${now.toISOString()}`);
    return { status: 'ok' };
  }

}
