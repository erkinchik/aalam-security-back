import { Injectable, NestMiddleware } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request, Response, NextFunction } from 'express';

/**
 * PRD-11: protect /metrics so it isn't browseable from the open internet.
 *
 * If METRICS_TOKEN is empty (typical for local dev) the endpoint is open.
 * If set, the scraper must present it as either:
 *   GET /metrics?token=<value>
 *   GET /metrics  with  Authorization: Bearer <value>
 */
@Injectable()
export class MetricsTokenMiddleware implements NestMiddleware {
  constructor(private readonly config: ConfigService) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const expected = this.config.get<string>('metricsToken');
    if (!expected) return next();

    const fromQuery =
      typeof req.query.token === 'string' ? req.query.token : undefined;
    const auth = req.headers.authorization;
    const fromHeader =
      typeof auth === 'string' && auth.startsWith('Bearer ')
        ? auth.slice('Bearer '.length)
        : undefined;

    if (fromQuery === expected || fromHeader === expected) return next();

    res.status(401).json({ statusCode: 401, message: 'Unauthorized' });
  }
}
