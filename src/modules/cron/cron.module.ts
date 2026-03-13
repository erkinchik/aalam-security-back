import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { CronService } from './cron.service';
import { WebsocketModule } from '../websocket/websocket.module';

@Module({
  imports: [ScheduleModule.forRoot(), WebsocketModule],
  providers: [CronService],
})
export class CronModule {}
