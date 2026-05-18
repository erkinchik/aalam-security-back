import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly client: Redis;

  constructor(private readonly configService: ConfigService) {
    const password = this.configService.get<string>('redis.password');
    this.client = new Redis({
      host: this.configService.get<string>('redis.host'),
      port: this.configService.get<number>('redis.port'),
      password: password && password.length > 0 ? password : undefined,
    });
  }

  getClient(): Redis {
    return this.client;
  }

  async addActiveEmergency(sessionId: string): Promise<void> {
    await this.client.sadd('active_emergencies', sessionId);
  }

  async removeActiveEmergency(sessionId: string): Promise<void> {
    await this.client.srem('active_emergencies', sessionId);
  }

  async setOperatorHeartbeat(operatorId: string): Promise<void> {
    await this.client.set(
      `operator:${operatorId}:heartbeat`,
      Date.now().toString(),
      'EX',
      30,
    );
  }

  async getOperatorHeartbeat(operatorId: string): Promise<string | null> {
    return this.client.get(`operator:${operatorId}:heartbeat`);
  }

  async storeRefreshToken(
    userId: string,
    token: string,
    ttlSeconds: number,
  ): Promise<void> {
    await this.client.set(`refresh:${userId}:${token}`, '1', 'EX', ttlSeconds);
  }

  async isRefreshTokenValid(
    userId: string,
    token: string,
  ): Promise<boolean> {
    const result = await this.client.exists(`refresh:${userId}:${token}`);
    return result === 1;
  }

  async removeRefreshToken(userId: string, token: string): Promise<void> {
    await this.client.del(`refresh:${userId}:${token}`);
  }

  async setPhoneVerificationToken(
    token: string,
    userId: string,
    ttlSeconds: number,
  ): Promise<void> {
    await this.client.set(`phone-verify:${token}`, userId, 'EX', ttlSeconds);
  }

  async getPhoneVerificationUserId(token: string): Promise<string | null> {
    return this.client.get(`phone-verify:${token}`);
  }

  async deletePhoneVerificationToken(token: string): Promise<void> {
    await this.client.del(`phone-verify:${token}`);
  }

  /**
   * Wipe every refresh token belonging to a user — used as the reaction to
   * detected reuse (SEC-12). Uses SCAN to avoid blocking Redis on large sets.
   */
  async removeAllRefreshTokens(userId: string): Promise<void> {
    const pattern = `refresh:${userId}:*`;
    let cursor = '0';
    do {
      const [next, keys] = await this.client.scan(
        cursor,
        'MATCH',
        pattern,
        'COUNT',
        100,
      );
      cursor = next;
      if (keys.length > 0) {
        await this.client.del(...keys);
      }
    } while (cursor !== '0');
  }

  async onModuleDestroy() {
    await this.client.quit();
  }
}
