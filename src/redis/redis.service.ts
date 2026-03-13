import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly client: Redis;

  constructor(private readonly configService: ConfigService) {
    this.client = new Redis({
      host: this.configService.get<string>('redis.host'),
      port: this.configService.get<number>('redis.port'),
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

  async onModuleDestroy() {
    await this.client.quit();
  }
}
