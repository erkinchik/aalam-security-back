import { Module } from '@nestjs/common';
import { SubscriptionRequestController } from './subscription-request.controller';
import { SubscriptionRequestService } from './subscription-request.service';

@Module({
  controllers: [SubscriptionRequestController],
  providers: [SubscriptionRequestService],
})
export class SubscriptionRequestModule {}
