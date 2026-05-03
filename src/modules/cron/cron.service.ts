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
    try {
      const staleSessions = await this.prisma.emergencySession.findMany({
        where: {
          status: { in: ['ASSIGNED', 'IN_PROGRESS'] },
          assignedOperatorId: { not: null },
        },
        include: {
          user: { select: { id: true, email: true } },
        },
      });

      if (staleSessions.length === 0) return;

      this.logger.log(`Checking heartbeats for ${staleSessions.length} active sessions...`);

      for (const session of staleSessions) {
        try {
          // 2. Проверяем, жив ли оператор в Redis
          const heartbeat = await this.redis.getOperatorHeartbeat(
            session.assignedOperatorId!,
          );

          if (!heartbeat) {
            this.logger.warn(
              `🚨 Operator ${session.assignedOperatorId} offline. Reassigning session ${session.id}`,
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
        } catch (innerError) {
          this.logger.error(`Error processing session ${session.id}:`, innerError.message);
        }
      }
    } catch (error) {
  
      this.logger.error('❌ Failed to run stale assignments check. Database might be down.');
    }
  }
}