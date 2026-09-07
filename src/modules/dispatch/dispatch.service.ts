import {
  Injectable,
  ConflictException,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { EmergencyStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { WebsocketGateway } from '../websocket/websocket.gateway';
import { isPrismaRowNotFound } from '../../common/utils/prisma-errors';
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
      if (!session) throw new NotFoundException('Session not found');
      if (session.assignedOperatorId !== operatorId) {
        throw new ForbiddenException('You are not assigned to this session');
      }
      throw new ConflictException(
        `Session must be in ASSIGNED status (current: ${session.status})`,
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

      await this.redis.removeActiveEmergency(sessionId);
      this.wsGateway.emitEmergencyClosed(
        updated.userId,
        updated as unknown as Record<string, unknown>,
      );
      return updated;
    } catch (err) {
      if (!isPrismaRowNotFound(err)) throw err;
      const session = await this.prisma.emergencySession.findUnique({
        where: { id: sessionId },
        select: { status: true, assignedOperatorId: true },
      });
      if (!session) throw new NotFoundException('Session not found');
      if (session.assignedOperatorId !== operatorId) {
        throw new ForbiddenException('You are not assigned to this session');
      }
      throw new ConflictException('Session is already closed');
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
    const operator = await this.prisma.user.update({
      where: { id: operatorId },
      data: { onShift: true, shiftStartedAt: new Date() },
      select: { onShift: true, shiftStartedAt: true },
    });

    // Seed the heartbeat right away so cron doesn't drop the shift before the
    // client's first ping lands.
    await this.redis.setOperatorHeartbeat(operatorId);
    await this.wsGateway.setOperatorShiftRoom(operatorId, true);

    return { ...operator, activeSessionCount: 0 };
  }

  async endShift(operatorId: string) {
    const activeSessionCount = await this.countOpenAssigned(operatorId);
    if (activeSessionCount > 0) {
      throw new ConflictException(
        `Нельзя сдать смену: у вас ${activeSessionCount} незакрытых вызовов. ` +
          'Закройте их или попросите администратора переназначить.',
      );
    }

    const operator = await this.prisma.user.update({
      where: { id: operatorId },
      data: { onShift: false, shiftStartedAt: null },
      select: { onShift: true, shiftStartedAt: true },
    });
    await this.wsGateway.setOperatorShiftRoom(operatorId, false);

    return { ...operator, activeSessionCount: 0 };
  }

  /**
   * Unclaimed SOS sessions. Empty for operators off shift — being on shift is
   * exactly what makes a session visible to them.
   */
  async getPool(operatorId: string, page: number, limit: number) {
    const operator = await this.prisma.user.findUnique({
      where: { id: operatorId },
      select: { onShift: true },
    });
    if (!operator?.onShift) {
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
    const operator = await this.prisma.user.findUnique({
      where: { id: operatorId },
      select: { onShift: true },
    });
    if (!operator?.onShift) {
      throw new ForbiddenException(
        'Заступите на смену, чтобы принимать вызовы',
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

      // Same event admin-driven assignment emits: other operators drop it from
      // their pool because the status is no longer NEW.
      this.wsGateway.emitEmergencyAssigned(
        updated.userId,
        updated as unknown as Record<string, unknown>,
      );
      return updated;
    } catch (err) {
      if (!isPrismaRowNotFound(err)) throw err;
      const existing = await this.prisma.emergencySession.findUnique({
        where: { id: sessionId },
        select: { status: true, assignedOperatorId: true },
      });
      if (!existing) throw new NotFoundException('Session not found');
      if (existing.assignedOperatorId) {
        throw new ConflictException('Вызов уже принят другим оператором');
      }
      throw new ConflictException(`Session is ${existing.status}`);
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
