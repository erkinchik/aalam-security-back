import { Injectable, NotFoundException } from '@nestjs/common';
import { EmergencyStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { WebsocketGateway } from '../websocket/websocket.gateway';
import { isPrismaRowNotFound } from '../../common/utils/prisma-errors';
import { ErrorCode } from '../../common/errors/error-codes';
import { conflict, forbidden, notFound } from '../../common/errors/app.exception';
import { OPERATOR_SESSION_INCLUDE } from '../../common/prisma/operator-session.include';
import { OPEN_ASSIGNED_STATUSES } from '../../common/constants/operator-presence';

@Injectable()
export class DispatchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly wsGateway: WebsocketGateway,
  ) {}

  async startProgress(sessionId: string, operatorId: string) {
    try {
      // REL-1: atomic conditional update — Prisma throws P2025 if no row
      // matches (status moved away from ASSIGNED, operator reassigned, etc.).
      const updated = await this.prisma.emergencySession.update({
        where: {
          id: sessionId,
          status: 'ASSIGNED',
          assignedOperatorId: operatorId,
        },
        data: { status: 'IN_PROGRESS' },
        include: {
          user: { select: { id: true, email: true, role: true } },
          assignedOperator: { select: { id: true, email: true } },
        },
      });

      this.wsGateway.emitEmergencyInProgress(
        updated.userId,
        updated as unknown as Record<string, unknown>,
      );
      return updated;
    } catch (err) {
      if (!isPrismaRowNotFound(err)) throw err;
      // Disambiguate so the client gets a useful 404/403/409.
      const session = await this.prisma.emergencySession.findUnique({
        where: { id: sessionId },
        select: { status: true, assignedOperatorId: true },
      });
      if (!session) throw notFound(ErrorCode.SESSION_NOT_FOUND, 'Session not found');
      if (session.assignedOperatorId !== operatorId) {
        throw forbidden(
          ErrorCode.NOT_ASSIGNED_TO_SESSION,
          'You are not assigned to this session',
        );
      }
      throw conflict(
        ErrorCode.SESSION_WRONG_STATUS,
        `Session must be in ASSIGNED status (current: ${session.status})`,
        { status: session.status },
      );
    }
  }

  async resolveSession(
    sessionId: string,
    operatorId: string,
    resolution: string,
  ) {
    try {
      const updated = await this.prisma.emergencySession.update({
        where: {
          id: sessionId,
          status: { not: 'CLOSED' },
          assignedOperatorId: operatorId,
        },
        data: {
          status: 'CLOSED',
          closedAt: new Date(),
          resolution,
        },
        include: {
          user: { select: { id: true, email: true, role: true } },
          assignedOperator: { select: { id: true, email: true } },
        },
      });

      this.wsGateway.emitEmergencyClosed(
        updated.userId,
        updated as unknown as Record<string, unknown>,
      );
      this.wsGateway.emitPoolRemoved(sessionId);
      return updated;
    } catch (err) {
      if (!isPrismaRowNotFound(err)) throw err;
      const session = await this.prisma.emergencySession.findUnique({
        where: { id: sessionId },
        select: { status: true, assignedOperatorId: true },
      });
      if (!session) throw notFound(ErrorCode.SESSION_NOT_FOUND, 'Session not found');
      if (session.assignedOperatorId !== operatorId) {
        throw forbidden(
          ErrorCode.NOT_ASSIGNED_TO_SESSION,
          'You are not assigned to this session',
        );
      }
      throw conflict(ErrorCode.SESSION_ALREADY_CLOSED, 'Session is already closed');
    }
  }

  async getOperatorHistory(operatorId: string, page: number, limit: number) {
    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      this.prisma.emergencySession.findMany({
        where: { assignedOperatorId: operatorId },
        include: {
          user: { select: { id: true, email: true, role: true } },
          locations: { orderBy: { createdAt: 'desc' }, take: 1 },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.emergencySession.count({
        where: { assignedOperatorId: operatorId },
      }),
    ]);

    return { data, total, page, limit };
  }

  async heartbeat(operatorId: string) {
    await this.redis.setOperatorHeartbeat(operatorId);
    return { status: 'ok' };
  }

  async getShift(operatorId: string) {
    const [operator, activeSessionCount] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: operatorId },
        select: { onShift: true, shiftStartedAt: true },
      }),
      this.countOpenAssigned(operatorId),
    ]);

    if (!operator) throw new NotFoundException('Operator not found');

    return {
      onShift: operator.onShift,
      shiftStartedAt: operator.shiftStartedAt,
      activeSessionCount,
    };
  }

  async startShift(operatorId: string) {
    // Время начала ставим только на переходе «не на смене → на смене». Иначе
    // повторный запрос (второй тап по ползунку, ретрай клиента) обнулял бы
    // отсчёт, и учёт рабочего времени по этому полю врал бы.
    await this.prisma.user.updateMany({
      where: { id: operatorId, onShift: false },
      data: { onShift: true, shiftStartedAt: new Date() },
    });
    const operator = await this.prisma.user.findUniqueOrThrow({
      where: { id: operatorId },
      select: { onShift: true, shiftStartedAt: true },
    });

    // Seed the heartbeat right away so cron doesn't drop the shift before the
    // client's first ping lands.
    await this.redis.setOperatorHeartbeat(operatorId);
    await this.wsGateway.setOperatorShiftRoom(operatorId, true);

    return { ...operator, activeSessionCount: 0 };
  }

  async endShift(operatorId: string) {
    // Условие «нет открытых вызовов» живёт в самом запросе: между отдельной
    // проверкой и обновлением админ успевал назначить вызов, и оператор уходил
    // со смены с висящим на нём выездом.
    const { count } = await this.prisma.user.updateMany({
      where: {
        id: operatorId,
        assignedSessions: {
          none: { status: { in: OPEN_ASSIGNED_STATUSES } },
        },
      },
      data: { onShift: false, shiftStartedAt: null },
    });

    if (count === 0) {
      const activeSessionCount = await this.countOpenAssigned(operatorId);
      throw conflict(
        ErrorCode.SHIFT_HAS_OPEN_SESSIONS,
        `Cannot end shift: ${activeSessionCount} open session(s)`,
        { openSessions: activeSessionCount },
      );
    }

    await this.wsGateway.setOperatorShiftRoom(operatorId, false);

    return { onShift: false, shiftStartedAt: null, activeSessionCount: 0 };
  }

  /**
   * Unclaimed SOS sessions. Empty for operators off shift — being on shift is
   * exactly what makes a session visible to them.
   */
  async getPool(operatorId: string, page: number, limit: number) {
    const [operator, openAssigned] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: operatorId },
        select: { onShift: true },
      }),
      this.countOpenAssigned(operatorId),
    ]);
    // Вне смены вызовы не приходят, а с незакрытым своим — не предлагаются:
    // оператор ведёт один вызов за раз.
    if (!operator?.onShift || openAssigned > 0) {
      return { data: [], total: 0, page, limit };
    }

    const where: Prisma.EmergencySessionWhereInput = {
      status: EmergencyStatus.NEW,
      assignedOperatorId: null,
    };
    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      this.prisma.emergencySession.findMany({
        where,
        include: OPERATOR_SESSION_INCLUDE,
        // Oldest first — the call waiting longest is the most urgent.
        orderBy: { createdAt: 'asc' },
        skip,
        take: limit,
      }),
      this.prisma.emergencySession.count({ where }),
    ]);

    return { data, total, page, limit };
  }

  /**
   * First operator to accept wins. The race is decided by the database: the
   * preconditions live in `where`, so a losing caller updates zero rows and
   * gets P2025 rather than silently stealing an already-claimed session.
   */
  async acceptSession(sessionId: string, operatorId: string) {
    const [operator, openAssigned] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: operatorId },
        select: { onShift: true },
      }),
      this.countOpenAssigned(operatorId),
    ]);
    if (!operator?.onShift) {
      throw forbidden(
        ErrorCode.NOT_ON_SHIFT,
        'Operator must be on shift to accept calls',
      );
    }
    if (openAssigned > 0) {
      throw conflict(
        ErrorCode.OPERATOR_BUSY,
        `Operator already has ${openAssigned} open session(s)`,
        { openSessions: openAssigned },
      );
    }

    try {
      const updated = await this.prisma.emergencySession.update({
        where: {
          id: sessionId,
          status: EmergencyStatus.NEW,
          assignedOperatorId: null,
        },
        data: {
          status: EmergencyStatus.ASSIGNED,
          assignedOperatorId: operatorId,
        },
        include: OPERATOR_SESSION_INCLUDE,
      });

      this.wsGateway.emitEmergencyAssigned(
        updated.userId,
        updated as unknown as Record<string, unknown>,
      );
      // Остальным дежурным — только идентификатор: им нужно убрать карточку из
      // пула, а не получить данные заявителя.
      this.wsGateway.emitPoolRemoved(sessionId);
      return updated;
    } catch (err) {
      if (!isPrismaRowNotFound(err)) throw err;
      const existing = await this.prisma.emergencySession.findUnique({
        where: { id: sessionId },
        select: { status: true, assignedOperatorId: true },
      });
      if (!existing) throw notFound(ErrorCode.SESSION_NOT_FOUND, 'Session not found');
      if (existing.assignedOperatorId) {
        throw conflict(
          ErrorCode.SESSION_ALREADY_CLAIMED,
          'Session was claimed by another operator',
        );
      }
      throw conflict(
        ErrorCode.SESSION_WRONG_STATUS,
        `Session is ${existing.status}`,
        { status: existing.status },
      );
    }
  }

  private countOpenAssigned(operatorId: string) {
    return this.prisma.emergencySession.count({
      where: {
        assignedOperatorId: operatorId,
        status: { in: OPEN_ASSIGNED_STATUSES },
      },
    });
  }
}
