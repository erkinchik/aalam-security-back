import { Module } from '@nestjs/common';
import { EmergencyController } from './emergency.controller';
import { EmergencyService } from './emergency.service';
import { WebsocketModule } from '../websocket/websocket.module';
import { OrganizationModule } from '../organization/organization.module';

@Module({
  imports: [WebsocketModule, OrganizationModule],
  controllers: [EmergencyController],
  providers: [EmergencyService],
})
export class EmergencyModule {}
