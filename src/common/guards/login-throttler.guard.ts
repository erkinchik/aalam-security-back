import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * Stricter throttler for /auth/login that keys by IP + lowercased email
 * (rather than IP only), so a distributed attacker can't shuffle through
 * 1000 accounts from the same IP under the per-IP allowance.
 *
 * Pair with `@Throttle({ default: { limit: 5, ttl: 900_000 } })` on the
 * route to get 5 attempts per 15 minutes per (IP, email) pair.
 */
@Injectable()
export class LoginThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, unknown>): Promise<string> {
    const ip = (req.ip as string | undefined) ?? 'unknown-ip';
    const body = (req.body as { email?: unknown } | undefined) ?? {};
    const email =
      typeof body.email === 'string' ? body.email.toLowerCase() : 'unknown';
    return `login:${ip}:${email}`;
  }
}
