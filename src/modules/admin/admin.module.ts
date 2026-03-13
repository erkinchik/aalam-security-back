import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { WebsocketModule } from '../websocket/websocket.module';
import { PushModule } from '../push/push.module';

@Module({
  imports: [WebsocketModule, PushModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
