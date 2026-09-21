import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import Redis from 'ioredis';
import { HEARTBEAT_TTL_SECONDS } from '../common/constants/operator-presence';

/**
 * Снимаем лок только если он всё ещё наш. Безусловный DEL удалял чужой лок,
 * если работа затянулась дольше TTL и ключ успел перехватить другой процесс.
 */
const RELEASE_LOCK_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0
`;

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly client: Redis;

  private readonly logger = new Logger(RedisService.name);

  constructor(private readonly configService: ConfigService) {
    const password = this.configService.get<string>('redis.password');
    this.client = new Redis({
      host: this.configService.get<string>('redis.host'),
      port: this.configService.get<number>('redis.port'),
      password: password && password.length > 0 ? password : undefined,
    });
    // Без слушателя ioredis отдаёт ошибку соединения как необработанное событие
    // 'error' — процесс падает вместо того, чтобы деградировать.
    this.client.on('error', (err) => {
      this.logger.error(`Redis connection error: ${err.message}`);
    });
  }

  getClient(): Redis {
    return this.client;
  }

  /**
   * Берёт распределённый лок. Возвращает токен владельца или null, если ключ
   * занят. Ошибку соединения не глотает — вызывающий решает сам, критично ли
   * отсутствие лока для его сценария.
   */
  async acquireLock(key: string, ttlSeconds: number): Promise<string | null> {
    const token = crypto.randomUUID();
    const ok = await this.client.set(key, token, 'EX', ttlSeconds, 'NX');
    return ok ? token : null;
  }

  /** Снимает лок, если он всё ещё принадлежит этому токену. */
  async releaseLock(key: string, token: string): Promise<void> {
    await this.client.eval(RELEASE_LOCK_SCRIPT, 1, key, token);
  }

  async setOperatorHeartbeat(operatorId: string): Promise<void> {
    await this.client.set(
      `operator:${operatorId}:heartbeat`,
      Date.now().toString(),
      'EX',
      HEARTBEAT_TTL_SECONDS,
    );
  }

  async getOperatorHeartbeat(operatorId: string): Promise<string | null> {
    return this.client.get(`operator:${operatorId}:heartbeat`);
  }

  /**
   * Batch variant of getOperatorHeartbeat — one round-trip for a whole list of
   * operators instead of a GET per operator.
   */
  async getOperatorHeartbeats(
    operatorIds: string[],
  ): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    if (operatorIds.length === 0) return result;

    const values = await this.client.mget(
      operatorIds.map((id) => `operator:${id}:heartbeat`),
    );
    operatorIds.forEach((id, i) => {
      const raw = values[i];
      if (!raw) return;
      const ts = parseInt(raw, 10);
      if (!Number.isNaN(ts)) result.set(id, ts);
    });
    return result;
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

  async onModuleDestroy() {
    await this.client.quit();
  }
}
