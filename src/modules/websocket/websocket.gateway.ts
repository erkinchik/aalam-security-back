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

@WebSocketGateway({
  namespace: '/ws',
  cors: { origin: '*' },
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
    this.server.to('operators').emit('emergency:location_update', payload);
    this.server.to(`user_${userId}`).emit('emergency:location_update', payload);
  }

  emitEmergencyAssigned(userId: string, session: Record<string, unknown>) {
    this.server.to('operators').emit('emergency:assigned', session);
    this.server.to(`user_${userId}`).emit('emergency:assigned', session);
  }

  emitEmergencyClosed(userId: string, session: Record<string, unknown>) {
    this.server.to('operators').emit('emergency:closed', session);
    this.server.to(`user_${userId}`).emit('emergency:closed', session);
  }

  emitEmergencyInProgress(userId: string, session: Record<string, unknown>) {
    this.server.to('operators').emit('emergency:in_progress', session);
    this.server.to(`user_${userId}`).emit('emergency:in_progress', session);
  }

  emitEmergencyReassigned(session: Record<string, unknown>) {
    this.server.to('operators').emit('emergency:reassigned', session);
    const userId = session.userId as string | undefined;
    if (userId) {
      this.server.to(`user_${userId}`).emit('emergency:reassigned', session);
    }
  }
}
