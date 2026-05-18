import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import { HealthService } from './health.service';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly indicators: HealthService,
  ) {}

  /**
   * Liveness — returns 200 as long as the process is running and the HTTP
   * server can accept requests. Used by Docker HEALTHCHECK / k8s livenessProbe.
   * MUST NOT depend on external services or it'll trigger restart storms.
   */
  @Get('live')
  @ApiOperation({ summary: 'Liveness probe (process is alive)' })
  @HealthCheck()
  live() {
    return this.health.check([]);
  }

  /**
   * Readiness — checks that the app can serve traffic (DB + Redis reachable).
   * Returns 503 if any dependency is down; load balancers should pull the
   * pod out of rotation but NOT restart it.
   */
  @Get('ready')
  @ApiOperation({ summary: 'Readiness probe (db + redis reachable)' })
  @HealthCheck()
  ready() {
    return this.health.check([
      () => this.indicators.pingPostgres(),
      () => this.indicators.pingRedis(),
    ]);
  }

  /** Back-compat: GET /health keeps working, behaves like /health/ready. */
  @Get()
  @ApiOperation({ summary: 'Alias of /health/ready (deprecated)' })
  @HealthCheck()
  legacy() {
    return this.health.check([
      () => this.indicators.pingPostgres(),
      () => this.indicators.pingRedis(),
    ]);
  }
}
