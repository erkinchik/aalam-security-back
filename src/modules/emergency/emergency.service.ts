import {
  Injectable,
  ConflictException,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { EmergencyType, OrganizationType, OrgMemberRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { WebsocketGateway } from '../websocket/websocket.gateway';
import { OrganizationService } from '../organization/organization.service';
import { CreateLocationDto } from './dto/create-location.dto';

@Injectable()
export class EmergencyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly wsGateway: WebsocketGateway,
    private readonly organizationService: OrganizationService,
  ) {}

  async startSession(userId: string, venueId?: string) {
    const activeSession = await this.prisma.emergencySession.findFirst({
      where: {
        userId,
        status: { not: 'CLOSED' },
      },
      include: { user: { select: { id: true, email: true, role: true } }, organization: true },
    });

    if (activeSession) {
      return activeSession;
    }

    let organizationId: string;
    let sessionVenueId: string | null = null;
    let emergencyType: EmergencyType = EmergencyType.PERSONAL;

    if (venueId) {
      const venue = await this.prisma.venue.findUnique({
        where: { id: venueId },
        include: { organization: true },
      });
      if (!venue) {
        throw new NotFoundException('Venue not found');
      }

      const membership = await this.prisma.organizationMember.findFirst({
        where: { userId, venueId },
        include: { organization: true, venue: true },
      });

      if (membership) {
        organizationId = membership.organizationId;
        sessionVenueId = membership.venueId;
        emergencyType = EmergencyType.VENUE;
      } else {
        const orgWideMember = await this.prisma.organizationMember.findFirst({
          where: {
            userId,
            organizationId: venue.organizationId,
            venueId: null,
            role: { in: [OrgMemberRole.MEMBER, OrgMemberRole.MANAGER] },
          },
        });
        if (
          orgWideMember &&
          venue.organization.type === OrganizationType.BUSINESS
        ) {
          organizationId = venue.organizationId;
          sessionVenueId = venue.id;
          emergencyType = EmergencyType.VENUE;
        } else {
          const orgOwner = await this.prisma.organizationMember.findFirst({
            where: {
              userId,
              organizationId: venue.organizationId,
              role: OrgMemberRole.OWNER,
            },
          });
          if (
            !orgOwner ||
            venue.organization.type !== OrganizationType.BUSINESS
          ) {
            throw new ForbiddenException(
              'You must be bound to this venue (enter invite code) before sending SOS',
            );
          }
          // Business owner: may request SOS for any venue of their org (no invite bind, no proximity check).
          organizationId = venue.organizationId;
          sessionVenueId = venue.id;
          emergencyType = EmergencyType.VENUE;
        }
      }
    } else {
      const subscriber = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { individualSubscriptionActive: true },
      });
      const businessOwnerMembership = await this.prisma.organizationMember.findFirst({
        where: { userId, role: OrgMemberRole.OWNER },
        include: { organization: { select: { type: true } } },
      });
      const isBusinessOwner =
        businessOwnerMembership?.organization.type === OrganizationType.BUSINESS;

      if (!subscriber?.individualSubscriptionActive && !isBusinessOwner) {
        throw new ForbiddenException(
          'Activate an individual plan or bind to a venue to use SOS',
        );
      }
      organizationId = await this.organizationService.ensureUserHasOrg(userId);
    }

    const session = await this.prisma.emergencySession.create({
      data: {
        userId,
        organizationId,
        venueId: sessionVenueId,
        emergencyType,
      },
      include: {
        user: { select: { id: true, email: true, role: true } },
        organization: true,
        venue: true,
      },
    });

    await this.redis.addActiveEmergency(session.id);
    this.wsGateway.emitEmergencyNew(session as unknown as Record<string, unknown>);

    return session;
  }

  async addLocation(sessionId: string, userId: string, dto: CreateLocationDto) {
    const session = await this.prisma.emergencySession.findUnique({
      where: { id: sessionId },
    });

    if (!session) {
      throw new NotFoundException('Session not found');
    }

    if (session.userId !== userId) {
      throw new ForbiddenException('Not your session');
    }

    if (session.status === 'CLOSED') {
      throw new ConflictException('Session is already closed');
    }

    const location = await this.prisma.emergencyLocation.create({
      data: {
        sessionId,
        latitude: dto.latitude,
        longitude: dto.longitude,
        accuracy: dto.accuracy,
      },
    });

    const sessionForEmit = await this.prisma.emergencySession.findUnique({
      where: { id: sessionId },
      include: {
        user: { select: { id: true, email: true, role: true } },
        organization: true,
        venue: true,
        locations: { orderBy: { createdAt: 'desc' }, take: 30 },
      },
    });

    this.wsGateway.emitLocationUpdate(
      userId,
      (sessionForEmit ?? session) as unknown as Record<string, unknown>,
      location as unknown as Record<string, unknown>,
    );

    return location;
  }

  async closeSession(sessionId: string, userId: string) {
    const session = await this.prisma.emergencySession.findUnique({
      where: { id: sessionId },
    });

    if (!session) {
      throw new NotFoundException('Session not found');
    }

    if (session.userId !== userId) {
      throw new ForbiddenException('Not your session');
    }

    if (session.status === 'CLOSED') {
      throw new ConflictException('Session is already closed');
    }

    const updated = await this.prisma.emergencySession.update({
      where: { id: sessionId },
      data: {
        status: 'CLOSED',
        closedAt: new Date(),
      },
      include: { user: { select: { id: true, email: true, role: true } } },
    });

    await this.redis.removeActiveEmergency(sessionId);
    this.wsGateway.emitEmergencyClosed(
      userId,
      updated as unknown as Record<string, unknown>,
    );

    return updated;
  }

  async getActiveSessions(operatorId: string, page: number, limit: number) {
    const skip = (page - 1) * limit;
    const where = {
      status: { in: ['ASSIGNED' as const, 'IN_PROGRESS' as const] },
      assignedOperatorId: operatorId,
    };

    const [data, total] = await Promise.all([
      this.prisma.emergencySession.findMany({
        where,
        include: {
          user: { select: { id: true, email: true, role: true } },
          organization: { select: { id: true, name: true } },
          venue: {
            select: {
              id: true,
              name: true,
              address: true,
              apartment: true,
              floor: true,
              entrance: true,
              doorCode: true,
              addressNotes: true,
              latitude: true,
              longitude: true,
            },
          },
          locations: { orderBy: { createdAt: 'desc' as const }, take: 1 },
          assignedOperator: { select: { id: true, email: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.emergencySession.count({ where }),
    ]);

    return { data, total, page, limit };
  }

  async getUserHistory(userId: string, page: number, limit: number) {
    const skip = (page - 1) * limit;
    const where = { userId };

    const [data, total] = await Promise.all([
      this.prisma.emergencySession.findMany({
        where,
        include: {
          locations: { orderBy: { createdAt: 'desc' as const }, take: 1 },
          assignedOperator: { select: { id: true, email: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.emergencySession.count({ where }),
    ]);

    return { data, total, page, limit };
  }
}
