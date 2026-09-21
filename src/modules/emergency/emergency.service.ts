import { Injectable, Logger } from '@nestjs/common';
import { EmergencyType, OrgMemberRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { WebsocketGateway } from '../websocket/websocket.gateway';
import { OrganizationService } from '../organization/organization.service';
import { PushService } from '../push/push.service';
import { CreateLocationDto } from './dto/create-location.dto';
import { isPrismaRowNotFound } from '../../common/utils/prisma-errors';
import { OPERATOR_SESSION_INCLUDE } from '../../common/prisma/operator-session.include';
import { ErrorCode } from '../../common/errors/error-codes';
import {
  conflict,
  forbidden,
  notFound,
} from '../../common/errors/app.exception';

// REL-2: hold a Redis lock for this long to suppress concurrent SOS triggers
// from the same user. 30 s is enough to cover normal request latency / retries.
const SOS_TRIGGER_LOCK_TTL_SECONDS = 30;

@Injectable()
export class EmergencyService {
  private readonly logger = new Logger(EmergencyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly wsGateway: WebsocketGateway,
    private readonly organizationService: OrganizationService,
    private readonly pushService: PushService,
  ) {}

  /**
   * REL-2: лок гасит дубли от повторных нажатий и ретраев одного пользователя.
   *
   * Недоступность Redis не должна отменять тревогу — это единственная функция
   * продукта. Поэтому сбой лока логируется и мы идём дальше без него: защита от
   * дублей деградирует, вызов проходит. На повторную сессию всё равно есть
   * проверка в `startSessionLocked`, она читает базу.
   */
  async startSession(userId: string, venueId?: string) {
    const lockKey = `sos:trigger:${userId}`;
    let token: string | null = null;
    let lockAvailable = true;

    try {
      token = await this.redis.acquireLock(lockKey, SOS_TRIGGER_LOCK_TTL_SECONDS);
    } catch (err) {
      lockAvailable = false;
      this.logger.error(
        'Redis unavailable for SOS trigger lock; proceeding without duplicate protection',
        err as Error,
      );
    }

    if (lockAvailable && !token) {
      // Параллельный запуск уже в работе: отдаём активную сессию, если она
      // успела записаться, иначе просим клиента подождать.
      const inFlight = await this.prisma.emergencySession.findFirst({
        where: { userId, status: { not: 'CLOSED' } },
        include: {
          user: { select: { id: true, email: true, role: true } },
          organization: true,
        },
      });
      if (inFlight) return inFlight;
      throw conflict(
        ErrorCode.SOS_IN_PROGRESS,
        'SOS request is already being processed',
      );
    }

    try {
      return await this.startSessionLocked(userId, venueId);
    } finally {
      if (token) {
        // Снятие лока не должно превращать успешный SOS в 500.
        await this.redis
          .releaseLock(lockKey, token)
          .catch((err: unknown) =>
            this.logger.error('Failed to release SOS trigger lock', err as Error),
          );
      }
    }
  }

  private async startSessionLocked(userId: string, venueId?: string) {
    const activeSession = await this.prisma.emergencySession.findFirst({
      where: {
        userId,
        status: { not: 'CLOSED' },
      },
      include: { user: { select: { id: true, email: true, role: true } }, organization: true, venue: true },
    });

    if (activeSession) {
      return activeSession;
    }

    let organizationId: string | null;
    let sessionVenueId: string | null = null;
    let emergencyType: EmergencyType = EmergencyType.PERSONAL;

    if (venueId) {
      const venue = await this.prisma.venue.findUnique({
        where: { id: venueId },
        include: { organization: true },
      });
      if (!venue) {
        throw notFound(ErrorCode.VENUE_NOT_FOUND, 'Venue not found');
      }

      const membership = await this.prisma.organizationMember.findFirst({
        where: { userId, venueId },
        include: { organization: true, venue: true },
      });

      if (membership) {
        organizationId = membership.organizationId;
        sessionVenueId = membership.venueId;
        emergencyType = EmergencyType.VENUE;
      } else {
        const orgWideMember = await this.prisma.organizationMember.findFirst({
          where: {
            userId,
            organizationId: venue.organizationId,
            venueId: null,
            role: { in: [OrgMemberRole.MEMBER, OrgMemberRole.MANAGER] },
          },
        });
        if (orgWideMember) {
          organizationId = venue.organizationId;
          sessionVenueId = venue.id;
          emergencyType = EmergencyType.VENUE;
        } else {
          const orgOwner = await this.prisma.organizationMember.findFirst({
            where: {
              userId,
              organizationId: venue.organizationId,
              role: OrgMemberRole.OWNER,
            },
          });
          if (!orgOwner) {
            throw forbidden(
              ErrorCode.VENUE_BIND_REQUIRED,
              'You must be bound to this venue before sending SOS',
            );
          }
          // Business owner: may request SOS for any venue of their org (no invite bind, no proximity check).
          organizationId = venue.organizationId;
          sessionVenueId = venue.id;
          emergencyType = EmergencyType.VENUE;
        }
      }
    } else {
      const subscriber = await this.prisma.user.findUnique({
        where: { id: userId },
        select: {
          individualSubscriptionActive: true,
          subscriptionExpiresAt: true,
        },
      });
      // Истёкшая подписка не даёт доступа. Срок null — активация без даты
      // (демо-режим); такие записи считаем бессрочными, чтобы не отключить тех,
      // кто пользовался системой до появления этой проверки.
      const hasActiveSubscription =
        subscriber?.individualSubscriptionActive === true &&
        (subscriber.subscriptionExpiresAt === null ||
          subscriber.subscriptionExpiresAt.getTime() > Date.now());
      // Владелец организации шлёт SOS без личной подписки.
      const isOrgOwner =
        (await this.prisma.organizationMember.count({
          where: { userId, role: OrgMemberRole.OWNER },
        })) > 0;

      if (!hasActiveSubscription && !isOrgOwner) {
        const expired =
          subscriber?.individualSubscriptionActive === true &&
          subscriber.subscriptionExpiresAt !== null;
        throw forbidden(
          expired ? ErrorCode.SUBSCRIPTION_EXPIRED : ErrorCode.SUBSCRIPTION_REQUIRED,
          expired
            ? 'Individual subscription has expired'
            : 'Activate an individual plan or bind to a venue to use SOS',
        );
      }
      // Только читаем существующее членство, ничего не создаём. Просто null
      // ставить нельзя: владелец бизнес-организации, отправляющий личный SOS
      // без выбора объекта, должен остаться привязан к своей организации.
      organizationId = await this.organizationService.findUserOrgId(userId);
    }

    const session = await this.prisma.emergencySession.create({
      data: {
        userId,
        organizationId,
        venueId: sessionVenueId,
        emergencyType,
      },
      // Та же форма, что у пула и снимка: карточка предложения у дежурного
      // сразу показывает телефон заявителя и вход в объект.
      include: OPERATOR_SESSION_INCLUDE,
    });

    void this.wsGateway.emitEmergencyNew(
      session as unknown as Record<string, unknown>,
    );
    // Fire-and-forget: a slow Expo call must never delay the SOS response.
    void this.pushService.sendSosAlert(session.id);

    return session;
  }

  /**
   * Самый горячий путь: координата прилетает каждые несколько секунд на каждый
   * активный вызов. Раньше здесь было три запроса (чтение → вставка → повторное
   * чтение с include) и окно TOCTOU между проверкой статуса и вставкой: вызов
   * успевали закрыть, а точка всё равно записывалась.
   *
   * Теперь одно условное обновление сессии с вложенной вставкой: преконды
   * (владелец, незакрытость) живут в `where`, так что гонку решает база.
   */
  async addLocation(sessionId: string, userId: string, dto: CreateLocationDto) {
    let session;
    try {
      session = await this.prisma.emergencySession.update({
        where: { id: sessionId, userId, status: { not: 'CLOSED' } },
        data: {
          locations: {
            create: {
              latitude: dto.latitude,
              longitude: dto.longitude,
              accuracy: dto.accuracy,
            },
          },
        },
        // Полная карточка: клиент оператора заменяет вызов этим payload, и без
        // телефона и входа в объект они пропадали с экрана на первом же пинге.
        // Из точек — только последняя, как и раньше.
        include: OPERATOR_SESSION_INCLUDE,
      });
    } catch (err) {
      if (!isPrismaRowNotFound(err)) throw err;
      const existing = await this.prisma.emergencySession.findUnique({
        where: { id: sessionId },
        select: { userId: true, status: true },
      });
      if (!existing) throw notFound(ErrorCode.SESSION_NOT_FOUND, 'Session not found');
      if (existing.userId !== userId) {
        throw forbidden(ErrorCode.NOT_YOUR_SESSION, 'Not your session');
      }
      throw conflict(ErrorCode.SESSION_ALREADY_CLOSED, 'Session is already closed');
    }

    const location = session.locations[0];
    this.wsGateway.emitLocationUpdate(
      userId,
      session as unknown as Record<string, unknown>,
      location as unknown as Record<string, unknown>,
    );

    return location;
  }

  async closeSession(sessionId: string, userId: string) {
    try {
      // REL-1: scopes ownership + non-closed precondition into the where clause.
      const updated = await this.prisma.emergencySession.update({
        where: {
          id: sessionId,
          userId,
          status: { not: 'CLOSED' },
        },
        data: {
          status: 'CLOSED',
          closedAt: new Date(),
        },
        include: { user: { select: { id: true, email: true, role: true } } },
      });

      this.wsGateway.emitEmergencyClosed(
        userId,
        updated as unknown as Record<string, unknown>,
      );
      // Заявитель мог отменить тревогу до того, как её кто-то принял: убираем
      // карточку у всех дежурных, кому она была предложена.
      this.wsGateway.emitPoolRemoved(sessionId);
      return updated;
    } catch (err) {
      if (!isPrismaRowNotFound(err)) throw err;
      const existing = await this.prisma.emergencySession.findUnique({
        where: { id: sessionId },
        select: { userId: true, status: true },
      });
      if (!existing) throw notFound(ErrorCode.SESSION_NOT_FOUND, 'Session not found');
      if (existing.userId !== userId) {
        throw forbidden(ErrorCode.NOT_YOUR_SESSION, 'Not your session');
      }
      throw conflict(ErrorCode.SESSION_ALREADY_CLOSED, 'Session is already closed');
    }
  }

  /** Вызовы, назначенные этому оператору, — не «активные вообще». */
  async getMyAssignedSessions(operatorId: string, page: number, limit: number) {
    const skip = (page - 1) * limit;
    const where = {
      status: { in: ['ASSIGNED' as const, 'IN_PROGRESS' as const] },
      assignedOperatorId: operatorId,
    };

    const [data, total] = await Promise.all([
      this.prisma.emergencySession.findMany({
        where,
        include: OPERATOR_SESSION_INCLUDE,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.emergencySession.count({ where }),
    ]);

    return { data, total, page, limit };
  }

  /**
   * Карточка вызова для оператора. Веб доставал её фильтром по списку активных
   * (`getActive().find()`), поэтому вызов со второй страницы не открывался, а
   * закрытый — не открывался никогда.
   *
   * Отдаём только то, что оператор ведёт или вёл: правило то же, что и у
   * рассылки событий — полная сессия достаётся тем, кто с ней работает.
   */
  async getOperatorSession(sessionId: string, operatorId: string) {
    const session = await this.prisma.emergencySession.findUnique({
      where: { id: sessionId },
      include: OPERATOR_SESSION_INCLUDE,
    });
    if (!session) {
      throw notFound(ErrorCode.SESSION_NOT_FOUND, 'Session not found');
    }
    if (session.assignedOperatorId !== operatorId) {
      throw forbidden(
        ErrorCode.NOT_ASSIGNED_TO_SESSION,
        'You are not assigned to this session',
      );
    }
    return session;
  }

  async getUserHistory(userId: string, page: number, limit: number) {
    const skip = (page - 1) * limit;
    const where = { userId };

    const [data, total] = await Promise.all([
      this.prisma.emergencySession.findMany({
        where,
        include: {
          locations: { orderBy: { createdAt: 'desc' as const }, take: 1 },
          assignedOperator: { select: { id: true, email: true } },
          // venue и organization — чтобы форма ответа совпадала с /emergency/start.
          // Раньше история отдавала сессию без объекта, и любой, кто принимал
          // её за полноценную, терял координаты поста.
          venue: true,
          organization: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.emergencySession.count({ where }),
    ]);

    return { data, total, page, limit };
  }
}
