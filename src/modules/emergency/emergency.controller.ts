import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { EmergencyService } from './emergency.service';
import { CreateLocationDto } from './dto/create-location.dto';
import { StartEmergencyDto } from './dto/start-emergency.dto';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

@ApiTags('Emergency')
@ApiBearerAuth()
@Controller('emergency')
@UseGuards(JwtAuthGuard, RolesGuard)
export class EmergencyController {
  constructor(private readonly emergencyService: EmergencyService) {}

  @Post('start')
  @Roles(Role.USER)
  @ApiOperation({ summary: 'Start a new SOS emergency session' })
  start(
    @CurrentUser() user: { id: string },
    // DTO-класс, а не тип в скобках: иначе ValidationPipe тело не проверял, и
    // {venueId: 123} ронял сервер с 500.
    @Body() body: StartEmergencyDto,
  ) {
    return this.emergencyService.startSession(user.id, body?.venueId);
  }

  @Get('active')
  @Roles(Role.OPERATOR)
  @ApiOperation({ summary: 'Sessions assigned to the current operator' })
  getActive(
    @CurrentUser() user: { id: string },
    @Query() query: PaginationQueryDto,
  ) {
    return this.emergencyService.getMyAssignedSessions(
      user.id,
      query.page ?? 1,
      query.limit ?? 20,
    );
  }

  @Get('history')
  @Roles(Role.USER)
  @ApiOperation({ summary: 'Get user emergency session history' })
  history(
    @CurrentUser() user: { id: string },
    @Query() query: PaginationQueryDto,
  ) {
    return this.emergencyService.getUserHistory(
      user.id,
      query.page ?? 1,
      query.limit ?? 20,
    );
  }

  @Post(':id/location')
  @Roles(Role.USER)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Send GPS location for an active session' })
  addLocation(
    @Param('id') id: string,
    @CurrentUser() user: { id: string },
    @Body() dto: CreateLocationDto,
  ) {
    return this.emergencyService.addLocation(id, user.id, dto);
  }

  @Post(':id/close')
  @Roles(Role.USER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Close an emergency session' })
  close(@Param('id') id: string, @CurrentUser() user: { id: string }) {
    return this.emergencyService.closeSession(id, user.id);
  }

  // Объявлен последним: иначе ':id' перехватил бы /emergency/history.
  @Get(':id')
  @Roles(Role.OPERATOR)
  @ApiOperation({ summary: 'Get one session assigned to the current operator' })
  getOne(@Param('id') id: string, @CurrentUser() user: { id: string }) {
    return this.emergencyService.getOperatorSession(id, user.id);
  }
}
