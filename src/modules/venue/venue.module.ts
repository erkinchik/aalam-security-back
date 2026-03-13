import { Module } from '@nestjs/common';
import { VenueController } from './venue.controller';
import { VenueService } from './venue.service';
import { OrganizationModule } from '../organization/organization.module';

@Module({
  imports: [OrganizationModule],
  controllers: [VenueController],
  providers: [VenueService],
})
export class VenueModule {}
