import { Module } from '@nestjs/common';
import { EmergencyContactController } from './emergency-contact.controller';
import { EmergencyContactService } from './emergency-contact.service';

@Module({
  controllers: [EmergencyContactController],
  providers: [EmergencyContactService],
})
export class EmergencyContactModule {}
