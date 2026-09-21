import { randomUUID } from 'node:crypto';
import { IncomingMessage, ServerResponse } from 'node:http';
import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { PrometheusModule } from '@willsoto/nestjs-prometheus';
import configuration, { validationSchema } from './config/configuration';
import { MetricsTokenMiddleware } from './common/middleware/metrics-token.middleware';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { AuthModule } from './modules/auth/auth.module';
import { MailModule } from './modules/mail/mail.module';
import { RefreshTokenModule } from './modules/refresh-token/refresh-token.module';
import { UsersModule } from './modules/users/users.module';
import { EmergencyModule } from './modules/emergency/emergency.module';
import { DispatchModule } from './modules/dispatch/dispatch.module';
import { WebsocketModule } from './modules/websocket/websocket.module';
import { AdminModule } from './modules/admin/admin.module';
import { HealthModule } from './modules/health/health.module';
import { CronModule } from './modules/cron/cron.module';
import { PushModule } from './modules/push/push.module';
import { OrganizationModule } from './modules/organization/organization.module';
import { VenueModule } from './modules/venue/venue.module';
import { EmergencyContactModule } from './modules/emergency-contact/emergency-contact.module';
import { OrganizationApplicationModule } from './modules/organization-application/organization-application.module';
import { SubscriptionRequestModule } from './modules/subscription-request/subscription-request.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validationSchema,
    }),
    // PRD-5: structured JSON logging via pino, with per-request req.id.
    // In dev we route through pino-pretty for human-readable output.
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const isProd = config.get<string>('nodeEnv') === 'production';
        return {
          pinoHttp: {
            level: config.get<string>('logLevel') ?? 'info',
            genReqId: (req: IncomingMessage) => {
              const hdr = req.headers['x-request-id'];
              return typeof hdr === 'string' && hdr.length > 0
                ? hdr
                : randomUUID();
            },
            customLogLevel: (_req, res: ServerResponse, err) => {
              if (err || res.statusCode >= 500) return 'error';
              if (res.statusCode >= 400) return 'warn';
              return 'info';
            },
            redact: {
              paths: [
                'req.headers.authorization',
                'req.headers.cookie',
                'req.body.password',
                'req.body.newPassword',
                'req.body.refreshToken',
                'req.body.token',
              ],
              remove: true,
            },
            transport: isProd
              ? undefined
              : { target: 'pino-pretty', options: { singleLine: true } },
          },
        };
      },
    }),
    // PRD-11: Prometheus default metrics + /metrics endpoint.
    PrometheusModule.register({
      defaultMetrics: { enabled: true },
    }),
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 60 }]),
    PrismaModule,
    RedisModule,
    MailModule,
    RefreshTokenModule,
    AuthModule,
    UsersModule,
    OrganizationModule,
    VenueModule,
    EmergencyContactModule,
    OrganizationApplicationModule,
    SubscriptionRequestModule,
    EmergencyModule,
    DispatchModule,
    WebsocketModule,
    AdminModule,
    HealthModule,
    CronModule,
    PushModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // PRD-11: gate /metrics with a shared token (no-op when METRICS_TOKEN is empty).
    consumer.apply(MetricsTokenMiddleware).forRoutes('metrics');
  }
}
