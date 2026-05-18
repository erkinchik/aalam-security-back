import { Injectable } from '@nestjs/common';
import {
  HealthIndicatorResult,
  HealthIndicatorService,
} from '@nestjs/terminus';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';

@Injectable()
export class HealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly indicator: HealthIndicatorService,
  ) {}

  async pingPostgres(): Promise<HealthIndicatorResult> {
    const i = this.indicator.check('postgres');
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return i.up();
    } catch (err) {
      return i.down({ message: (err as Error).message });
    }
  }

  async pingRedis(): Promise<HealthIndicatorResult> {
    const i = this.indicator.check('redis');
    try {
      const pong = await this.redis.getClient().ping();
      if (pong !== 'PONG') return i.down({ message: `unexpected reply: ${pong}` });
      return i.up();
    } catch (err) {
      return i.down({ message: (err as Error).message });
    }
  }
}
