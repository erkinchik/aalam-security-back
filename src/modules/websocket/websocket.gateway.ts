import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { EmergencyStatus } from '@prisma/client';
import { Server, Socket } from 'socket.io';
import { PrismaService } from '../../prisma/prisma.service';
import { OPERATOR_SESSION_INCLUDE } from '../../common/prisma/operator-session.include';
import { OPEN_ASSIGNED_STATUSES } from '../../common/constants/operator-presence';

/** Operators on shift — the only ones alerted about a fresh SOS. */
export const ON_SHIFT_ROOM = 'on_shift_operators';

/** Per-operator room, so shift endpoints can move sockets without tracking them. */
export const operatorRoom = (operatorId: string) => `operator_${operatorId}`;

/** За сколько до истечения токена предупредить клиента. */
const TOKEN_EXPIRY_WARNING_MS = 60_000;

/**
 * Проверка Origin читается при вычислении декоратора, поэтому берём переменную
 * окружения напрямую — ConfigService тут ещё недоступен.
 *
 * Пустой список закрывает доступ, а не открывает: у HTTP-CORS в `main.ts` ровно
 * такое поведение, и расходиться им незачем. Запросы без Origin пропускаем —
 * это нативные клиенты, и они всё равно предъявляют JWT.
 */
type OriginCallback = (err: Error | null, allow?: boolean) => void;
function websocketOriginCheck(origin: string | undefined, cb: OriginCallback) {
  if (!origin) return cb(null, true);
  const allowed = (process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowed.includes(origin)) return cb(null, true);
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
        this.logger.debug('Socket rejected: no token in handshake');
        client.disconnect();
        return;
      }

      const payload = this.jwtService.verify(token, {
        secret: this.configService.get<string>('jwt.accessSecret'),
      });

      // Роль берём из базы, а не из payload: разжалованный или удалённый
      // пользователь иначе сохранял бы прежние права до истечения токена.
      const user = await this.prisma.user.findUnique({
        where: { id: payload.sub },
        select: { role: true, deletedAt: true },
      });
      if (!user || user.deletedAt) {
        this.logger.warn(`Socket rejected: user ${payload.sub} is gone or deleted`);
        client.disconnect();
        return;
      }

      client.data.user = { id: payload.sub, role: user.role };
      this.scheduleTokenExpiry(client, payload.exp);

      if (user.role === 'ADMIN') {
        client.join('admin_room');
        this.logger.log(`Admin ${payload.sub} connected`);
        // REL-6: replay open sessions so a reconnecting admin doesn't miss
        // events emitted while they were disconnected.
        void this.sendAdminBootstrap(client);
      } else if (user.role === 'OPERATOR') {
        client.join('operators');
        // Personal room lets the HTTP shift endpoints move this operator in and
        // out of ON_SHIFT_ROOM without tracking sockets by hand.
        client.join(operatorRoom(payload.sub));
        this.logger.log(`Operator ${payload.sub} connected`);
        void this.sendOperatorBootstrap(client, payload.sub);
      } else {
        client.join(`user_${payload.sub}`);
        this.logger.log(`User ${payload.sub} connected`);
      }
    } catch (err) {
      // Раньше причина глушилась: протухший токен, неверный секрет и битый
      // payload выглядели одинаково — «все отключаются», ноль строк в логе.
      this.logger.warn(
        `Socket handshake rejected: ${(err as Error)?.message ?? 'unknown reason'}`,
      );
      client.disconnect();
    }
  }

  /**
   * Токен проверялся только на хендшейке, а сокет жил часами: вышедший из
   * системы оператор продолжал получать поток вызовов. Теперь соединение живёт
   * ровно столько, сколько действует токен.
   *
   * За минуту до истечения шлём `auth:expiring` — клиент успевает обновить токен
   * и переподключиться без разрыва.
   */
  private scheduleTokenExpiry(client: Socket, exp: unknown) {
    if (typeof exp !== 'number') return;

    const msLeft = exp * 1000 - Date.now();
    if (msLeft <= 0) {
      client.disconnect();
      return;
    }

    const warnAt = Math.max(0, msLeft - TOKEN_EXPIRY_WARNING_MS);
    const warnTimer = setTimeout(() => client.emit('auth:expiring'), warnAt);
    const killTimer = setTimeout(() => {
      this.logger.debug(`Socket ${client.data?.user?.id} closed: token expired`);
      client.disconnect();
    }, msLeft);

    client.once('disconnect', () => {
      clearTimeout(warnTimer);
      clearTimeout(killTimer);
    });
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

  /**
   * REL-6 for operators: an operator who reconnects mid-shift would otherwise
   * miss every `emergency:new` emitted while the socket was down. Replays the
   * unclaimed pool plus the sessions already assigned to them.
   */
  private async sendOperatorBootstrap(client: Socket, operatorId: string) {
    try {
      const operator = await this.prisma.user.findUnique({
        where: { id: operatorId },
        select: { onShift: true },
      });
      if (operator?.onShift) {
        client.join(ON_SHIFT_ROOM);
      }

      const mine = await this.prisma.emergencySession.findMany({
        where: {
          assignedOperatorId: operatorId,
          status: { in: OPEN_ASSIGNED_STATUSES },
        },
        include: OPERATOR_SESSION_INCLUDE,
        orderBy: { createdAt: 'desc' },
      });

      // Оператор ведёт один вызов за раз: пока свой не закрыт, свободные ему
      // не предлагаются — иначе после переподключения на карту вернулась бы
      // карточка предложения поверх активного вызова.
      const pool =
        operator?.onShift && mine.length === 0
          ? await this.prisma.emergencySession.findMany({
              where: {
                status: EmergencyStatus.NEW,
                assignedOperatorId: null,
              },
              include: OPERATOR_SESSION_INCLUDE,
              orderBy: { createdAt: 'desc' },
              take: 100,
            })
          : [];

      // onShift — чтобы клиент, пропустивший operator:shift_ended, узнал о снятой
      // смене при первом же переподключении, а не продолжал ждать вызовов.
      client.emit('emergency:bootstrap', {
        sessions: [...mine, ...pool],
        onShift: Boolean(operator?.onShift),
      });
    } catch (err) {
      this.logger.error(
        'Failed to send operator bootstrap snapshot',
        err as Error,
      );
    }
  }

  /**
   * Сообщает оператору, что смена окончена не по его команде: cron снял её из-за
   * молчания, либо это сделал администратор. Без такого события клиент продолжал
   * показывать «На смене», хотя сервер уже перестал слать ему вызовы.
   */
  emitShiftEnded(operatorId: string, reason: 'inactivity' | 'admin') {
    this.server.to(operatorRoom(operatorId)).emit('operator:shift_ended', { reason });
  }

  /**
   * Идентификаторы дежурных операторов, у которых прямо сейчас живой сокет.
   * Socket.IO сам поддерживает ping/pong и отключает мёртвые соединения,
   * поэтому открытый сокет — более честный признак присутствия, чем HTTP-пинг,
   * который замирает, как только телефон уходит в фон.
   */
  async getConnectedOnShiftOperatorIds(): Promise<string[]> {
    const sockets = await this.server.in(ON_SHIFT_ROOM).fetchSockets();
    const ids = new Set<string>();
    for (const socket of sockets) {
      const id = (socket.data as { user?: { id?: string } })?.user?.id;
      if (id) ids.add(id);
    }
    return [...ids];
  }

  /**
   * Moves every socket of this operator in or out of the on-shift broadcast
   * room. Called by the shift endpoints, which have no socket reference.
   */
  async setOperatorShiftRoom(operatorId: string, onShift: boolean) {
    const room = this.server.in(operatorRoom(operatorId));
    if (onShift) {
      await room.socketsJoin(ON_SHIFT_ROOM);
    } else {
      await room.socketsLeave(ON_SHIFT_ROOM);
    }
  }

  handleDisconnect(client: Socket) {
    const user = client.data?.user;
    if (user) {
      this.logger.log(`Client ${user.id} disconnected`);
    }
  }

  /**
   * Новый вызов уходит только свободным дежурным. Занятого он бы дёрнул
   * сиреной посреди своего выезда, а принять всё равно нельзя.
   *
   * Список занятых считается на месте, а не поддерживается отдельной комнатой:
   * рассинхрон такой комнаты стоил бы потерянного вызова, а запрос идёт по
   * индексу assignedOperatorId.
   */
  async emitEmergencyNew(session: Record<string, unknown>) {
    await this.offerToFreeOperators(session);
  }

  /**
   * Вызов вернулся в пул — админ снял назначение или cron вернул зависший.
   * Свободные дежурные должны увидеть его как обычное предложение, поэтому
   * событие то же самое: клиенту незачем различать «новый» и «вернувшийся».
   */
  async emitPoolReturned(
    session: Record<string, unknown>,
    { notifyAdmins = true }: { notifyAdmins?: boolean } = {},
  ) {
    await this.offerToFreeOperators(session, notifyAdmins);
  }

  /**
   * `includeAdmins: false` — когда вызов вернул в пул сам админ: emergency:new
   * включает у него сирену, а о своём же действии сигналить незачем. Список у
   * админа обновит emergency:reassigned, которое уходит в admin_room всегда.
   */
  private async offerToFreeOperators(session: Record<string, unknown>, includeAdmins = true) {
    let busyRooms: string[] = [];
    try {
      busyRooms = await this.busyOperatorRooms();
    } catch (err) {
      // Показать вызов занятому — мелкая помеха, не показать никому — потеря
      // тревоги. При сбое запроса шлём всем дежурным.
      this.logger.error(
        'Failed to resolve busy operators; broadcasting SOS to every operator on shift',
        err as Error,
      );
    }
    this.server
      .to(includeAdmins ? ['admin_room', ON_SHIFT_ROOM] : [ON_SHIFT_ROOM])
      .except(busyRooms)
      .emit('emergency:new', session);
  }

  /**
   * Вызов перестал быть свободным: приняли, назначили или закрыли до приёма.
   * Дежурным уходит один идентификатор — им нужно лишь убрать карточку, а
   * полная сессия содержит имя, телефон, адрес и координаты заявителя, и
   * показывать её тем, кто с вызовом не работает, незачем.
   */
  emitPoolRemoved(sessionId: string) {
    this.server.to(ON_SHIFT_ROOM).emit('emergency:pool_removed', { id: sessionId });
  }

  /**
   * Комнаты, которым положена полная сессия: администраторы, заявитель и те
   * операторы, что с вызовом работают. Раньше сюда входила общая комната
   * `operators`, и персональные данные уходили каждому подключённому оператору.
   */
  private sessionRooms(
    userId: string | null | undefined,
    ...operatorIds: (string | null | undefined)[]
  ): string[] {
    const rooms = new Set<string>(['admin_room']);
    if (userId) rooms.add(`user_${userId}`);
    for (const id of operatorIds) {
      if (id) rooms.add(operatorRoom(id));
    }
    return [...rooms];
  }

  private assigneeOf(session: Record<string, unknown>): string | null {
    const id = session.assignedOperatorId;
    return typeof id === 'string' ? id : null;
  }

  /** Персональные комнаты операторов, у которых уже есть незакрытый вызов. */
  private async busyOperatorRooms(): Promise<string[]> {
    const busy = await this.prisma.emergencySession.findMany({
      where: {
        status: { in: OPEN_ASSIGNED_STATUSES },
        assignedOperatorId: { not: null },
      },
      select: { assignedOperatorId: true },
      distinct: ['assignedOperatorId'],
    });
    return busy.flatMap((s) =>
      s.assignedOperatorId ? [operatorRoom(s.assignedOperatorId)] : [],
    );
  }

  emitLocationUpdate(
    userId: string,
    session: Record<string, unknown>,
    location: Record<string, unknown>,
  ) {
    const payload = { session, location };
    this.server
      .to(this.sessionRooms(userId, this.assigneeOf(session)))
      .emit('emergency:location_update', payload);
  }

  emitEmergencyAssigned(userId: string, session: Record<string, unknown>) {
    this.server
      .to(this.sessionRooms(userId, this.assigneeOf(session)))
      .emit('emergency:assigned', session);
  }

  /**
   * `previousOperatorId` нужен админскому закрытию: оно обнуляет исполнителя тем
   * же запросом, и без явной передачи оператор, который вёл вызов, не узнал бы,
   * что его закрыли.
   */
  emitEmergencyClosed(
    userId: string,
    session: Record<string, unknown>,
    previousOperatorId?: string | null,
  ) {
    this.server
      .to(this.sessionRooms(userId, this.assigneeOf(session), previousOperatorId))
      .emit('emergency:closed', session);
  }

  emitEmergencyInProgress(userId: string, session: Record<string, unknown>) {
    this.server
      .to(this.sessionRooms(userId, this.assigneeOf(session)))
      .emit('emergency:in_progress', session);
  }

  /**
   * Прежнего исполнителя уведомляем отдельно: иначе оператор, у которого забрали
   * вызов, просто видел, как карточка исчезает с карты.
   */
  emitEmergencyReassigned(
    session: Record<string, unknown>,
    previousOperatorId?: string | null,
  ) {
    const userId = session.userId as string | undefined;
    this.server
      .to(this.sessionRooms(userId, this.assigneeOf(session), previousOperatorId))
      .emit('emergency:reassigned', session);
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
