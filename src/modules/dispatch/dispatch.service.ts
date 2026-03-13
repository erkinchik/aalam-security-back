import {
  Injectable,
  ConflictException,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { WebsocketGateway } from '../websocket/websocket.gateway';

@Injectable()
export class DispatchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly wsGateway: WebsocketGateway,
  ) {}

  async startProgress(sessionId: string, operatorId: string) {
    const session = await this.prisma.emergencySession.findUnique({
      where: { id: sessionId },
    });

    if (!session) {
      throw new NotFoundException('Session not found');
    }

    if (session.assignedOperatorId !== operatorId) {
      throw new ForbiddenException('You are not assigned to this session');
    }

    if (session.status !== 'ASSIGNED') {
      throw new ConflictException('Session must be in ASSIGNED status');
    }

    const updated = await this.prisma.emergencySession.update({
      where: { id: sessionId },
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
  }

  async resolveSession(
    sessionId: string,
    operatorId: string,
    resolution: string,
  ) {
    const session = await this.prisma.emergencySession.findUnique({
      where: { id: sessionId },
    });

    if (!session) {
      throw new NotFoundException('Session not found');
    }

    if (session.assignedOperatorId !== operatorId) {
      throw new ForbiddenException('You are not assigned to this session');
    }

    if (session.status === 'CLOSED') {
      throw new ConflictException('Session is already closed');
    }

    const updated = await this.prisma.emergencySession.update({
      where: { id: sessionId },
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
}
