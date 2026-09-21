import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Хранилище refresh-токенов.
 *
 * Раньше жило в Redis, и его недоступность означала, что войти не может никто:
 * выдача токена требовала записи в кэш. База доступна всегда, когда вообще
 * работает приложение, поэтому сессии переехали сюда.
 *
 * В строке лежит SHA-256 от токена: доступ на чтение к базе не должен давать
 * готовый набор действующих сессий.
 */
@Injectable()
export class RefreshTokenService {
  private readonly logger = new Logger(RefreshTokenService.name);

  constructor(private readonly prisma: PrismaService) {}

  private hash(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  async store(userId: string, token: string, ttlSeconds: number): Promise<void> {
    await this.prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: this.hash(token),
        expiresAt: new Date(Date.now() + ttlSeconds * 1000),
      },
    });
  }

  /** Токен действителен, пока строка существует и срок не вышел. */
  async isValid(userId: string, token: string): Promise<boolean> {
    const row = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: this.hash(token) },
      select: { userId: true, expiresAt: true },
    });
    return (
      row != null && row.userId === userId && row.expiresAt.getTime() > Date.now()
    );
  }

  async remove(token: string): Promise<void> {
    await this.prisma.refreshToken.deleteMany({
      where: { tokenHash: this.hash(token) },
    });
  }

  /** Все сессии пользователя — при смене пароля и удалении учётной записи. */
  async removeAllForUser(userId: string): Promise<void> {
    await this.prisma.refreshToken.deleteMany({ where: { userId } });
  }

  /** Чистка просроченных: TTL в базе сам ничего не удаляет, в отличие от Redis. */
  async removeExpired(): Promise<number> {
    const { count } = await this.prisma.refreshToken.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    if (count > 0) this.logger.log(`Removed ${count} expired refresh token(s)`);
    return count;
  }
}
