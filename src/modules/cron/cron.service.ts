import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Role } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { WebsocketGateway } from '../websocket/websocket.gateway';
import { RefreshTokenService } from '../refresh-token/refresh-token.service';
import { isPrismaRowNotFound } from '../../common/utils/prisma-errors';
import {
  OPEN_ASSIGNED_STATUSES,
  RECLAIM_ASSIGNMENT_THRESHOLD_MS,
  SHIFT_ALIVE_THRESHOLD_MS,
  isHeartbeatFresh,
} from '../../common/constants/operator-presence';
import { OPERATOR_SESSION_INCLUDE } from '../../common/prisma/operator-session.include';
import { lockOperatorRow } from '../../common/prisma/operator-lock';

const STALE_LOCK_KEY = 'cron:stale-assignments';
const SUBSCRIPTION_LOCK_KEY = 'cron:expire-subscriptions';
const SUBSCRIPTION_LOCK_TTL_SECONDS = 300;
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
    private readonly refreshTokens: RefreshTokenService,
  ) {}

  @Cron(CronExpression.EVERY_30_SECONDS)
  async checkStaleAssignments() {
    // REL-3: distributed lock so we're safe under horizontal scale.
    const lockToken = await this.redis
      .acquireLock(STALE_LOCK_KEY, STALE_LOCK_TTL_SECONDS)
      .catch((err: unknown) => {
        this.logger.error('Redis unavailable for stale-assignment lock', err as Error);
        return null;
      });
    if (!lockToken) {
      this.logger.debug('Stale-assignment lock held by another worker, skipping');
      return;
    }

    try {
      // Открытый сокет — тоже признак жизни. HTTP-пинг замирает, как только
      // телефон уходит в фон или гаснет экран, и оператор слетал со смены,
      // продолжая при этом видеть интерфейс дежурного.
      await this.refreshPresenceFromSockets();

      // Только ASSIGNED: вызов «В работе» оператор ведёт из навигатора или
      // звонка, где пульс замолкает, — его не отбираем (см. operator-presence).
      const staleSessions = await this.prisma.emergencySession.findMany({
        where: {
          status: 'ASSIGNED',
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
          // Ключ heartbeat живёт дольше любого порога, поэтому сравниваем
          // отметку времени, а не факт существования.
          if (isHeartbeatFresh(heartbeat, RECLAIM_ASSIGNMENT_THRESHOLD_MS)) {
            continue;
          }

          this.logger.warn(
            `Operator ${session.assignedOperatorId} offline. Reassigning session ${session.id}`,
          );

          try {
            // Conditional update so we don't accidentally reset a session
            // that was closed or already reassigned between the read and write.
            const updated = await this.prisma.emergencySession.update({
              where: {
                id: session.id,
                status: 'ASSIGNED',
                assignedOperatorId: session.assignedOperatorId,
              },
              data: {
                status: 'NEW',
                assignedOperatorId: null,
              },
              // Полный include: вызов возвращается в пул, и карточка предложения
              // у дежурных должна отрисоваться так же, как у свежего SOS.
              include: OPERATOR_SESSION_INCLUDE,
            });

            this.wsGateway.emitEmergencyReassigned(
              updated as unknown as Record<string, unknown>,
              session.assignedOperatorId,
            );
            void this.wsGateway.emitPoolReturned(
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
      await this.redis
        .releaseLock(STALE_LOCK_KEY, lockToken)
        .catch((err: unknown) =>
          this.logger.error('Failed to release stale-assignment lock', err as Error),
        );
    }
  }

  /** Продлевает присутствие всем дежурным, у кого сейчас живой сокет. */
  private async refreshPresenceFromSockets() {
    try {
      const ids = await this.wsGateway.getConnectedOnShiftOperatorIds();
      await Promise.all(ids.map((id) => this.redis.setOperatorHeartbeat(id)));
    } catch (error) {
      this.logger.error('Failed to refresh presence from sockets', error as Error);
    }
  }

  /**
   * An operator whose device died stays flagged on-shift forever, keeps
   * receiving SOS broadcasts nobody reads, and pollutes the admin roster.
   * Silence longer than SHIFT_ALIVE_THRESHOLD_MS ends the shift for them.
   */
  private async dropDeadShifts() {
    try {
      // С открытым вызовом смену не снимаем: ASSIGNED к этому моменту уже
      // вернулись в пул, а IN_PROGRESS остаётся за оператором и в пути.
      const onShift = await this.prisma.user.findMany({
        where: {
          role: Role.OPERATOR,
          onShift: true,
          assignedSessions: { none: { status: { in: OPEN_ASSIGNED_STATUSES } } },
        },
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

      // По одному и под той же блокировкой строки оператора, что у приёма
      // вызова: условие «нет открытых» иначе не видело вызов, принятый, пока
      // запрос ждал. Событие — только тем, с кого смену правда сняли.
      const ended: string[] = [];
      for (const id of dead) {
        const count = await this.prisma.$transaction(async (tx) => {
          await lockOperatorRow(tx, id);
          const result = await tx.user.updateMany({
            where: {
              id,
              onShift: true,
              assignedSessions: { none: { status: { in: OPEN_ASSIGNED_STATUSES } } },
            },
            data: { onShift: false, shiftStartedAt: null },
          });
          return result.count;
        });
        if (count > 0) ended.push(id);
      }
      if (ended.length === 0) return;
      await Promise.all(
        ended.map(async (id) => {
          // Событие уходит до выхода из комнаты — иначе оно не дойдёт.
          this.wsGateway.emitShiftEnded(id, 'inactivity');
          await this.wsGateway.setOperatorShiftRoom(id, false);
        }),
      );
      this.logger.warn(
        `Ended shift for ${ended.length} unreachable operator(s): ${ended.join(', ')}`,
      );
    } catch (error) {
      this.logger.error('Failed to drop dead operator shifts', error as Error);
    }
  }

  /**
   * Просроченные refresh-токены в базе сами не исчезают, в отличие от ключей
   * Redis с TTL. Раз в час подчищаем, иначе таблица растёт бесконечно.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async cleanupRefreshTokens() {
    try {
      await this.refreshTokens.removeExpired();
    } catch (error) {
      this.logger.error('Failed to clean up expired refresh tokens', error as Error);
    }
  }

  /**
   * Гасит флаг подписки, когда её срок истёк. Проверка при старте SOS и так
   * смотрит на дату, но без этой задачи в базе копятся пользователи, формально
   * числящиеся подписчиками: их видно в админке и в /users/me как активных.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async expireSubscriptions() {
    const lockToken = await this.redis
      .acquireLock(SUBSCRIPTION_LOCK_KEY, SUBSCRIPTION_LOCK_TTL_SECONDS)
      .catch((err: unknown) => {
        this.logger.error('Redis unavailable for subscription lock', err as Error);
        return null;
      });
    if (!lockToken) return;

    try {
      const { count } = await this.prisma.user.updateMany({
        where: {
          individualSubscriptionActive: true,
          subscriptionExpiresAt: { not: null, lt: new Date() },
        },
        data: { individualSubscriptionActive: false },
      });
      if (count > 0) {
        this.logger.log(`Expired ${count} individual subscription(s)`);
      }
    } catch (error) {
      this.logger.error('Failed to expire subscriptions', error as Error);
    } finally {
      await this.redis
        .releaseLock(SUBSCRIPTION_LOCK_KEY, lockToken)
        .catch(() => undefined);
    }
  }
}