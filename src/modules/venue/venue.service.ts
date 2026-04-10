import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { OrgMemberRole, OrganizationType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { OrganizationService } from '../organization/organization.service';
import { CreateVenueDto } from './dto/create-venue.dto';
import { generateUniqueInviteCodeAcrossTables } from './utils/invite-code';

@Injectable()
export class VenueService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly organizationService: OrganizationService,
  ) {}

  private async ensureUniqueInviteCode(): Promise<string> {
    return generateUniqueInviteCodeAcrossTables(this.prisma);
  }

  async create(
    userId: string,
    organizationId: string,
    dto: CreateVenueDto,
    isAdmin = false,
  ) {
    if (!isAdmin) {
      const canManage = await this.organizationService.canManageOrganizationVenues(
        userId,
        organizationId,
      );
      if (!canManage) {
        throw new ForbiddenException(
          'You do not have permission to create venues for this organization',
        );
      }
    }

    const inviteCode = await this.ensureUniqueInviteCode();

    return this.prisma.venue.create({
      data: {
        organizationId,
        name: dto.name,
        address: dto.address,
        apartment: dto.apartment,
        floor: dto.floor,
        entrance: dto.entrance,
        doorCode: dto.doorCode,
        addressNotes: dto.addressNotes,
        latitude: dto.latitude,
        longitude: dto.longitude,
        inviteCode,
      },
    });
  }

  async bindByInviteCode(userId: string, inviteCode: string) {
    const code = inviteCode.trim().toUpperCase();

    const org = await this.prisma.organization.findFirst({
      where: {
        inviteCode: { equals: code, mode: 'insensitive' },
        type: OrganizationType.BUSINESS,
      },
      select: { id: true, name: true },
    });

    if (org) {
      await this.prisma.$transaction(async (tx) => {
        await tx.organizationMember.deleteMany({
          where: { userId },
        });

        await tx.organizationMember.create({
          data: {
            userId,
            organizationId: org.id,
            venueId: null,
            role: OrgMemberRole.MEMBER,
          },
        });
      });

      return {
        bindType: 'organization' as const,
        organization: { id: org.id, name: org.name },
      };
    }

    const venue = await this.prisma.venue.findFirst({
      where: { inviteCode: { equals: code, mode: 'insensitive' } },
      include: { organization: { select: { id: true, name: true } } },
    });

    if (!venue) {
      throw new NotFoundException('Invalid invite code');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.organizationMember.deleteMany({
        where: { userId },
      });

      await tx.organizationMember.create({
        data: {
          userId,
          organizationId: venue.organizationId,
          venueId: venue.id,
          role: OrgMemberRole.MEMBER,
        },
      });
    });

    const full = await this.prisma.venue.findUnique({
      where: { id: venue.id },
      include: {
        organization: { select: { id: true, name: true } },
      },
    });

    return {
      bindType: 'venue' as const,
      id: full!.id,
      name: full!.name,
      organization: full!.organization,
    };
  }

  async listByOrganization(userId: string, organizationId: string, isAdmin = false) {
    if (!isAdmin) {
      const hasAccess = await this.organizationService.userHasAccess(userId, organizationId);
      if (!hasAccess) throw new ForbiddenException('No access to this organization');
    }

    return this.prisma.venue.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'asc' },
    });
  }
}
