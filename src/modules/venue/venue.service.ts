import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  ConflictException,
} from '@nestjs/common';
import { OrgMemberRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { OrganizationService } from '../organization/organization.service';
import { CreateVenueDto } from './dto/create-venue.dto';
import { generateInviteCode } from './utils/invite-code';

@Injectable()
export class VenueService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly organizationService: OrganizationService,
  ) {}

  private async ensureUniqueInviteCode(): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = generateInviteCode(6);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const existing = await (this.prisma.venue as any).findFirst({
        where: { inviteCode: code },
      });
      if (!existing) return code;
    }
    throw new ConflictException('Failed to generate unique invite code');
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
          'Only organization owners and managers can create venues',
        );
      }
    }

    const inviteCode = await this.ensureUniqueInviteCode();

    return (this.prisma.venue as any).create({
      data: {
        organizationId,
        name: dto.name,
        address: dto.address,
        latitude: dto.latitude,
        longitude: dto.longitude,
        inviteCode,
      },
    });
  }

  async bindByInviteCode(userId: string, inviteCode: string) {
    const code = inviteCode.trim().toUpperCase();
    const venue = await (this.prisma.venue as any).findFirst({
      where: { inviteCode: { equals: code, mode: 'insensitive' } },
      include: { organization: true },
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

    return this.prisma.venue.findUnique({
      where: { id: venue.id },
      include: {
        organization: { select: { id: true, name: true } },
      },
    });
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
