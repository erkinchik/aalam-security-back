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
import { DispatchService } from './dispatch.service';
import { ResolveSessionDto } from './dto/resolve-session.dto';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

@ApiTags('Dispatch')
@ApiBearerAuth()
@Controller('dispatch')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.OPERATOR)
export class DispatchController {
  constructor(private readonly dispatchService: DispatchService) {}

  @Post(':id/start-progress')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark session as in-progress / GBR dispatched (OPERATOR only)' })
  startProgress(
    @Param('id') id: string,
    @CurrentUser() user: { id: string },
  ) {
    return this.dispatchService.startProgress(id, user.id);
  }

  @Post(':id/resolve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Resolve and close an emergency session (OPERATOR only)' })
  resolve(
    @Param('id') id: string,
    @CurrentUser() user: { id: string },
    @Body() dto: ResolveSessionDto,
  ) {
    return this.dispatchService.resolveSession(id, user.id, dto.resolution);
  }

  @Get('history')
  @ApiOperation({ summary: 'Get operator assigned session history (OPERATOR only)' })
  history(
    @CurrentUser() user: { id: string },
    @Query() query: PaginationQueryDto,
  ) {
    return this.dispatchService.getOperatorHistory(
      user.id,
      query.page ?? 1,
      query.limit ?? 20,
    );
  }

  @Post('heartbeat')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Operator heartbeat ping' })
  heartbeat(@CurrentUser() user: { id: string }) {
    return this.dispatchService.heartbeat(user.id);
  }

  @Get('shift')
  @ApiOperation({ summary: 'Current shift state of the operator' })
  getShift(@CurrentUser() user: { id: string }) {
    return this.dispatchService.getShift(user.id);
  }

  @Post('shift/start')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Go on shift — start receiving new SOS alerts' })
  startShift(@CurrentUser() user: { id: string }) {
    return this.dispatchService.startShift(user.id);
  }

  @Post('shift/end')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'End shift (409 while the operator still has open sessions)',
  })
  endShift(@CurrentUser() user: { id: string }) {
    return this.dispatchService.endShift(user.id);
  }

  @Get('pool')
  @ApiOperation({
    summary: 'Unclaimed SOS sessions (empty when the operator is off shift)',
  })
  pool(
    @CurrentUser() user: { id: string },
    @Query() query: PaginationQueryDto,
  ) {
    return this.dispatchService.getPool(
      user.id,
      query.page ?? 1,
      query.limit ?? 20,
    );
  }

  @Post(':id/accept')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Claim an unassigned session — first caller wins' })
  accept(@Param('id') id: string, @CurrentUser() user: { id: string }) {
    return this.dispatchService.acceptSession(id, user.id);
  }
}
