import { Controller, Get, Post, Delete, Body, Param, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Role } from '@prisma/client';
import { EmergencyContactService } from './emergency-contact.service';
import { CreateEmergencyContactDto } from './dto/create-emergency-contact.dto';

@ApiTags('Emergency Contacts')
@ApiBearerAuth()
@Controller('emergency-contacts')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.USER)
export class EmergencyContactController {
  constructor(private readonly emergencyContactService: EmergencyContactService) {}

  @Post()
  @ApiOperation({ summary: 'Add an emergency contact' })
  create(
    @CurrentUser() user: { id: string },
    @Body() dto: CreateEmergencyContactDto,
  ) {
    return this.emergencyContactService.create(user.id, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List my emergency contacts' })
  list(@CurrentUser() user: { id: string }) {
    return this.emergencyContactService.listByUser(user.id);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete an emergency contact' })
  delete(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
  ) {
    return this.emergencyContactService.delete(user.id, id);
  }
}
