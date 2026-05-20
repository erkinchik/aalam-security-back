import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Server, Socket } from 'socket.io';
import { PrismaService } from '../../prisma/prisma.service';

// Origin-check function read at decorator-eval time. Re-reads process.env on
// each request so an env reload doesn't require a rebuild. Allows requests
// with no Origin header (native mobile clients).
type OriginCallback = (err: Error | null, allow?: boolean) => void;
function websocketOriginCheck(origin: string | undefined, cb: OriginCallback) {
  if (!origin) return cb(null, true);
  const allowed = (process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowed.length === 0 || allowed.includes(origin)) {
    return cb(null, true);
  }
  return cb(new Error(`Origin ${origin} not allowed by CORS`), false);
}

@WebSocketGateway({
  namespace: '/ws',
  cors: { origin: websocketOriginCheck, credentials: true },
})
export class WebsocketGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(WebsocketGateway.name);

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async handleConnection(client: Socket) {
    try {
      const token =
        client.handshake.auth?.token ||
        client.handshake.headers?.authorization?.replace('Bearer ', '');

      if (!token) {
        client.disconnect();
        return;
      }

      const payload = this.jwtService.verify(token, {
        secret: this.configService.get<string>('jwt.accessSecret'),
      });

      client.data.user = { id: payload.sub, role: payload.role };

      if (payload.role === 'ADMIN') {
        client.join('admin_room');
        this.logger.log(`Admin ${payload.sub} connected`);
        // REL-6: replay open sessions so a reconnecting admin doesn't miss
        // events emitted while they were disconnected.
        void this.sendAdminBootstrap(client);
      } else if (payload.role === 'OPERATOR') {
        client.join('operators');
        this.logger.log(`Operator ${payload.sub} connected`);
      } else {
        client.join(`user_${payload.sub}`);
        this.logger.log(`User ${payload.sub} connected`);
      }
    } catch {
      client.disconnect();
    }
  }

  private async sendAdminBootstrap(client: Socket) {
    try {
      const sessions = await this.prisma.emergencySession.findMany({
        where: { status: { in: ['NEW', 'ASSIGNED', 'IN_PROGRESS'] } },
        include: {
          user: { select: { id: true, email: true, role: true } },
          organization: { select: { id: true, name: true } },
          assignedOperator: { select: { id: true, email: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 100,
      });
      client.emit('emergency:bootstrap', { sessions });
    } catch (err) {
      this.logger.error('Failed to send admin bootstrap snapshot', err as Error);
    }
  }

  handleDisconnect(client: Socket) {
    const user = client.data?.user;
    if (user) {
      this.logger.log(`Client ${user.id} disconnected`);
    }
  }

  emitEmergencyNew(session: Record<string, unknown>) {
    this.server.to('admin_room').emit('emergency:new', session);
  }

  emitLocationUpdate(
    userId: string,
    session: Record<string, unknown>,
    location: Record<string, unknown>,
  ) {
    const payload = { session, location };
    this.server
      .to(['admin_room', 'operators', `user_${userId}`])
      .emit('emergency:location_update', payload);
  }

  emitEmergencyAssigned(userId: string, session: Record<string, unknown>) {
    this.server
      .to(['admin_room', 'operators', `user_${userId}`])
      .emit('emergency:assigned', session);
  }

  emitEmergencyClosed(userId: string, session: Record<string, unknown>) {
    this.server
      .to(['admin_room', 'operators', `user_${userId}`])
      .emit('emergency:closed', session);
  }

  emitEmergencyInProgress(userId: string, session: Record<string, unknown>) {
    this.server
      .to(['admin_room', 'operators', `user_${userId}`])
      .emit('emergency:in_progress', session);
  }

  emitEmergencyReassigned(session: Record<string, unknown>) {
    const rooms: string[] = ['admin_room', 'operators'];
    const userId = session.userId as string | undefined;
    if (userId) rooms.push(`user_${userId}`);
    this.server.to(rooms).emit('emergency:reassigned', session);
  }

  emitSubscriptionApproved(
    userId: string,
    payload: { requestId: string; expiresAt: Date | null },
  ) {
    this.server.to(`user_${userId}`).emit('subscription:approved', {
      requestId: payload.requestId,
      expiresAt: payload.expiresAt?.toISOString() ?? null,
    });
  }

  emitSubscriptionRejected(
    userId: string,
    payload: { requestId: string; reason: string | null },
  ) {
    this.server.to(`user_${userId}`).emit('subscription:rejected', {
      requestId: payload.requestId,
      reason: payload.reason,
    });
  }
}
