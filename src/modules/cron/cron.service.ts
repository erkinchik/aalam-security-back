import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Role } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { WebsocketGateway } from '../websocket/websocket.gateway';
import { isPrismaRowNotFound } from '../../common/utils/prisma-errors';
import {
  ONLINE_THRESHOLD_MS,
  SHIFT_ALIVE_THRESHOLD_MS,
  isHeartbeatFresh,
} from '../../common/constants/operator-presence';

const STALE_LOCK_KEY = 'cron:stale-assignments';
// Lock TTL just longer than the schedule (30s) so a hanging worker doesn't
// block the next tick indefinitely, but still prevents two workers from
// colliding when scaled horizontally.
const STALE_LOCK_TTL_SECONDS = 45;

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
    // REL-3: distributed lock so we're safe under horizontal scale.
    const acquired = await this.redis
      .getClient()
      .set(STALE_LOCK_KEY, '1', 'EX', STALE_LOCK_TTL_SECONDS, 'NX');
    if (!acquired) {
      this.logger.debug('Stale-assignment lock held by another worker, skipping');
      return;
    }

    try {
      const staleSessions = await this.prisma.emergencySession.findMany({
        where: {
          status: { in: ['ASSIGNED', 'IN_PROGRESS'] },
          assignedOperatorId: { not: null },
        },
        select: { id: true, assignedOperatorId: true },
      });

      if (staleSessions.length === 0) return;

      for (const session of staleSessions) {
        try {
          const heartbeat = await this.redis.getOperatorHeartbeat(
            session.assignedOperatorId!,
          );
          // The heartbeat key outlives the online window (it also backs the
          // shift check), so compare the timestamp rather than mere existence.
          if (isHeartbeatFresh(heartbeat, ONLINE_THRESHOLD_MS)) continue;

          this.logger.warn(
            `Operator ${session.assignedOperatorId} offline. Reassigning session ${session.id}`,
          );

          try {
            // Conditional update so we don't accidentally reset a session
            // that was closed or already reassigned between the read and write.
            const updated = await this.prisma.emergencySession.update({
              where: {
                id: session.id,
                status: { in: ['ASSIGNED', 'IN_PROGRESS'] },
                assignedOperatorId: session.assignedOperatorId,
              },
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
          } catch (updateErr) {
            if (isPrismaRowNotFound(updateErr)) continue; // state moved on, fine
            throw updateErr;
          }
        } catch (innerError) {
          this.logger.error(
            `Error processing session ${session.id}`,
            innerError as Error,
          );
        }
      }
    } catch (error) {
      this.logger.error(
        'Failed to run stale assignments check (DB unreachable?)',
        error as Error,
      );
    } finally {
      // Sessions are freed first: dropping the shift of an operator who still
      // held calls would leave those calls stranded.
      await this.dropDeadShifts();
      await this.redis.getClient().del(STALE_LOCK_KEY);
    }
  }

  /**
   * An operator whose device died stays flagged on-shift forever, keeps
   * receiving SOS broadcasts nobody reads, and pollutes the admin roster.
   * Silence longer than SHIFT_ALIVE_THRESHOLD_MS ends the shift for them.
   */
  private async dropDeadShifts() {
    try {
      const onShift = await this.prisma.user.findMany({
        where: { role: Role.OPERATOR, onShift: true },
        select: { id: true },
      });
      if (onShift.length === 0) return;

      const heartbeats = await this.redis.getOperatorHeartbeats(
        onShift.map((o) => o.id),
      );
      const now = Date.now();
      const dead = onShift
        .map((o) => o.id)
        .filter((id) => {
          const ts = heartbeats.get(id);
          return ts == null || now - ts >= SHIFT_ALIVE_THRESHOLD_MS;
        });
      if (dead.length === 0) return;

      await this.prisma.user.updateMany({
        where: { id: { in: dead } },
        data: { onShift: false, shiftStartedAt: null },
      });
      await Promise.all(
        dead.map((id) => this.wsGateway.setOperatorShiftRoom(id, false)),
      );
      this.logger.warn(
        `Ended shift for ${dead.length} unreachable operator(s): ${dead.join(', ')}`,
      );
    } catch (error) {
      this.logger.error('Failed to drop dead operator shifts', error as Error);
    }
  }
}