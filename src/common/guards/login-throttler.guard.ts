import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { ThrottlerRequest } from '@nestjs/throttler';

/** SEC-6: 5 попыток входа за 15 минут на пару (IP, email). */
export const LOGIN_LIMIT = 5;
export const LOGIN_TTL_MS = 900_000;

/**
 * Stricter throttler for /auth/login that keys by IP + lowercased email
 * (rather than IP only), so a distributed attacker can't shuffle through
 * 1000 accounts from the same IP under the per-IP allowance.
 *
 * The limit is fixed here instead of coming from `@Throttle` on the route:
 * that decorator is read by *every* throttler guard, so it also shrank the
 * global IP-keyed guard to 5 requests per 15 minutes. Behind a carrier NAT
 * that locked out an entire network after five sign-ins. The route now keeps
 * the generous global per-IP allowance, and the strict per-account limit
 * lives only in this guard.
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

  protected handleRequest(requestProps: ThrottlerRequest): Promise<boolean> {
    return super.handleRequest({
      ...requestProps,
      limit: LOGIN_LIMIT,
      ttl: LOGIN_TTL_MS,
    });
  }
}
