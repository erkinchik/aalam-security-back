import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import configuration, { validationSchema } from './config/configuration';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { AuthModule } from './modules/auth/auth.module';
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

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validationSchema,
    }),
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 60 }]),
    PrismaModule,
    RedisModule,
    AuthModule,
    UsersModule,
    OrganizationModule,
    VenueModule,
    EmergencyContactModule,
    OrganizationApplicationModule,
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
export class AppModule {}
