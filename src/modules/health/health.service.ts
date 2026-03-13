import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';

@Injectable()
export class HealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async check() {
    let postgres = false;
    let redis = false;

    try {
      await this.prisma.$queryRaw`SELECT 1`;
      postgres = true;
    } catch {}

    try {
      const pong = await this.redis.getClient().ping();
      redis = pong === 'PONG';
    } catch {}

    return {
      status: postgres && redis ? 'ok' : 'degraded',
      postgres,
      redis,
    };
  }
}
