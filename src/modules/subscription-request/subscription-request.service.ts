import {
  ConflictException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Prisma, SubscriptionRequestStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateSubscriptionRequestDto } from './dto/create-subscription-request.dto';

@Injectable()
export class SubscriptionRequestService {
  private readonly logger = new Logger(SubscriptionRequestService.name);

  constructor(private readonly prisma: PrismaService) {}

  async create(userId: string, dto: CreateSubscriptionRequestDto) {
    try {
      const created = await this.prisma.subscriptionRequest.create({
        data: {
          userId,
          comment: dto.comment ?? null,
        },
      });
      this.logger.log(
        `Subscription request created: id=${created.id} userId=${userId}`,
      );
      return created;
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw new ConflictException(
          'У вас уже есть заявка на рассмотрении',
        );
      }
      throw e;
    }
  }

  async getCurrentForUser(userId: string) {
    const pending = await this.prisma.subscriptionRequest.findFirst({
      where: { userId, status: SubscriptionRequestStatus.PENDING },
      orderBy: { createdAt: 'desc' },
    });
    if (pending) return pending;

    return this.prisma.subscriptionRequest.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }
}
