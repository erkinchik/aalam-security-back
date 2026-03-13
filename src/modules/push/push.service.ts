import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

@Injectable()
export class PushService {
  constructor(private readonly prisma: PrismaService) {}

  async sendSosAlert(sessionId: string, organizationId: string) {
    const operators = await this.prisma.organizationMember.findMany({
      where: {
        organizationId,
        role: { in: ['OWNER', 'MANAGER', 'OPERATOR'] },
        user: { role: 'OPERATOR', pushToken: { not: null } },
      },
      include: { user: { select: { pushToken: true } } },
    });

    const tokens = operators
      .map((o) => o.user.pushToken)
      .filter((t): t is string => !!t);
    if (tokens.length === 0) return;

    const messages = tokens.map((token) => ({
      to: token,
      sound: 'default',
      title: '🚨 SOS Emergency',
      body: 'New emergency alert. Open the app to respond.',
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
        const body = await res.text();
        console.error('[Push] Expo API error:', res.status, body);
      }
    } catch (err) {
      console.error('[Push] Failed to send:', err);
    }
  }

  async sendAssignmentToOperator(sessionId: string, operatorId: string) {
    const operator = await this.prisma.user.findUnique({
      where: { id: operatorId, role: 'OPERATOR' },
      select: { pushToken: true },
    });

    if (!operator?.pushToken) return;

    try {
      const res = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: operator.pushToken,
          sound: 'default',
          title: '📋 Вызов назначен',
          body: 'Вам назначен новый вызов. Откройте приложение.',
          data: { sessionId, type: 'emergency:assigned' },
          channelId: 'sos-emergency',
          priority: 'high',
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        console.error('[Push] Assignment Expo API error:', res.status, body);
      }
    } catch (err) {
      console.error('[Push] Failed to send assignment:', err);
    }
  }
}
