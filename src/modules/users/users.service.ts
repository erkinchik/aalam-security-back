import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

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
        createdAt: true,
      },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return user;
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
