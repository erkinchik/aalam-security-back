import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { WebsocketGateway } from '../websocket/websocket.gateway';

@Injectable()
export class CronService {
  private readonly logger = new Logger(CronService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly wsGateway: WebsocketGateway,
  ) {}

  @Cron(CronExpression.EVERY_30_SECONDS)
  async checkStaleAssignments() {
    const staleSessions = await this.prisma.emergencySession.findMany({
      where: {
        status: { in: ['ASSIGNED', 'IN_PROGRESS'] },
        assignedOperatorId: { not: null },
      },
    });

    for (const session of staleSessions) {
      const heartbeat = await this.redis.getOperatorHeartbeat(
        session.assignedOperatorId!,
      );

      if (!heartbeat) {
        this.logger.warn(
          `Operator ${session.assignedOperatorId} heartbeat expired, reassigning session ${session.id}`,
        );

        const updated = await this.prisma.emergencySession.update({
          where: { id: session.id },
          data: {
            status: 'NEW',
            assignedOperatorId: null,
          },
          include: {
            user: { select: { id: true, email: true, role: true } },
          },
        });

        this.wsGateway.emitEmergencyReassigned(
          updated as unknown as Record<string, unknown>,
        );
      }
    }
  }
}
