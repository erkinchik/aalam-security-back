import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';

/**
 * Authenticates server-to-server callbacks from the Telegram bot via a
 * shared secret in the `X-Bot-Secret` header. Uses constant-time comparison
 * to avoid leaking the secret through timing.
 */
@Injectable()
export class SharedSecretGuard implements CanActivate {
  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const provided = request.headers['x-bot-secret'];
    const expected = this.configService.get<string>('telegram.botSecret');

    if (
      !expected ||
      typeof provided !== 'string' ||
      provided.length !== expected.length
    ) {
      throw new UnauthorizedException();
    }

    const providedBuf = Buffer.from(provided);
    const expectedBuf = Buffer.from(expected);

    if (!timingSafeEqual(providedBuf, expectedBuf)) {
      throw new UnauthorizedException();
    }

    return true;
  }
}
