import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { UpdateUserMeDto } from './dto/update-user-me.dto';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

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

  async getOperatorPushTokens(): Promise<string[]> {
    const operators = await this.prisma.user.findMany({
      where: { role: 'OPERATOR', pushToken: { not: null } },
      select: { pushToken: true },
    });
    return operators.map((o) => o.pushToken!).filter(Boolean);
  }
}
