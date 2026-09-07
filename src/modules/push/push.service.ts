import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

// Expo per-message ticket shape we care about.
type ExpoTicket = {
  status: 'ok' | 'error';
  details?: { error?: string };
  message?: string;
};

@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * REL-5: parse Expo response and clear push tokens for which the device is
   * no longer registered. Expo doesn't return HTTP 410 — it returns 200 with
   * `data[i].details.error === 'DeviceNotRegistered'` per-message.
   */
  private async clearDeadTokens(tokens: string[], body: unknown): Promise<void> {
    const tickets =
      (body as { data?: ExpoTicket[] } | null)?.data ?? [];
    const stale: string[] = [];
    for (let i = 0; i < tickets.length; i++) {
      const t = tickets[i];
      if (
        t?.status === 'error' &&
        t.details?.error === 'DeviceNotRegistered' &&
        tokens[i]
      ) {
        stale.push(tokens[i]);
      }
    }
    if (stale.length === 0) return;
    await this.prisma.user.updateMany({
      where: { pushToken: { in: stale } },
      data: { pushToken: null },
    });
    this.logger.warn(
      `Cleared ${stale.length} stale push token(s) (DeviceNotRegistered)`,
    );
  }

  /**
   * Broadcast a fresh SOS to every operator on shift. Operators are a global
   * pool — they are deliberately not scoped to the raising organization.
   */
  async sendSosAlert(sessionId: string) {
    const operators = await this.prisma.user.findMany({
      where: { role: 'OPERATOR', onShift: true, pushToken: { not: null } },
      select: { pushToken: true },
    });

    const tokens = operators
      .map((o) => o.pushToken)
      .filter((t): t is string => !!t);
    if (tokens.length === 0) {
      this.logger.warn(
        `SOS ${sessionId} raised with no operator on shift to alert`,
      );
      return;
    }

    const messages = tokens.map((token) => ({
      to: token,
      sound: 'default',
      title: '🚨 Новый SOS',
      body: 'Поступил вызов. Откройте приложение, чтобы принять.',
      data: { sessionId, type: 'emergency:new' },
      channelId: 'sos-emergency',
      priority: 'high',
    }));

    try {
      const res = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(messages),
      });
      if (!res.ok) {
        const text = await res.text();
        this.logger.error(`Expo API error ${res.status}: ${text}`);
        return;
      }
      const json = await res.json();
      await this.clearDeadTokens(tokens, json);
    } catch (err) {
      this.logger.error('Failed to send SOS push', err as Error);
    }
  }

  async sendSubscriptionDecision(
    userId: string,
    decision: 'approved' | 'rejected',
    payload: { requestId: string; expiresAt?: Date | null; reason?: string | null },
  ) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { pushToken: true },
    });
    if (!user?.pushToken) return;

    const tokens = [user.pushToken];
    const title =
      decision === 'approved' ? '✅ Подписка активирована' : '❌ Заявка отклонена';
    const body =
      decision === 'approved'
        ? payload.expiresAt
          ? `Подписка активна до ${payload.expiresAt.toLocaleDateString('ru-RU')}`
          : 'Подписка активна'
        : payload.reason
          ? `Причина: ${payload.reason}`
          : 'Ваша заявка на подписку отклонена';

    const messages = [
      {
        to: user.pushToken,
        sound: 'default',
        title,
        body,
        data: {
          type: `subscription:${decision}`,
          requestId: payload.requestId,
          expiresAt: payload.expiresAt?.toISOString(),
        },
        channelId: 'sos-emergency',
        priority: 'high',
      },
    ];

    try {
      const res = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(messages),
      });
      if (!res.ok) {
        const text = await res.text();
        this.logger.error(`Expo API error ${res.status}: ${text}`);
        return;
      }
      const json = await res.json();
      await this.clearDeadTokens(tokens, json);
    } catch (err) {
      this.logger.error('Failed to send subscription decision push', err as Error);
    }
  }

  async sendAssignmentToOperator(sessionId: string, operatorId: string) {
    const operator = await this.prisma.user.findUnique({
      where: { id: operatorId, role: 'OPERATOR' },
      select: { pushToken: true },
    });

    if (!operator?.pushToken) return;

    const tokens = [operator.pushToken];
    const messages = [
      {
        to: operator.pushToken,
        sound: 'default',
        title: '📋 Вызов назначен',
        body: 'Вам назначен новый вызов. Откройте приложение.',
        data: { sessionId, type: 'emergency:assigned' },
        channelId: 'sos-emergency',
        priority: 'high',
      },
    ];

    try {
      const res = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(messages),
      });
      if (!res.ok) {
        const text = await res.text();
        this.logger.error(`Expo API error ${res.status}: ${text}`);
        return;
      }
      const json = await res.json();
      await this.clearDeadTokens(tokens, json);
    } catch (err) {
      this.logger.error('Failed to send assignment push', err as Error);
    }
  }
}
