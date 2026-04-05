import { Module } from '@nestjs/common';
import { OrganizationApplicationController } from './organization-application.controller';
import { OrganizationApplicationService } from './organization-application.service';

@Module({
  controllers: [OrganizationApplicationController],
  providers: [OrganizationApplicationService],
})
export class OrganizationApplicationModule {}
