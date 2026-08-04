import { Injectable, ConflictException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateOrganizationDto } from './dto/create-organization.dto';
import { OrgMemberRole, OrganizationType } from '@prisma/client';
import { generateUniqueInviteCodeAcrossTables } from '../venue/utils/invite-code';

@Injectable()
export class OrganizationService {
  constructor(private readonly prisma: PrismaService) {}

  /** Create a personal organization for a new user (used during registration) */
  async create(userId: string, dto: CreateOrganizationDto) {
    const alreadyMember = await this.prisma.organizationMember.findUnique({
      where: { userId },
    });
    if (alreadyMember) {
      throw new ConflictException(
        'You already belong to an organization. Use an organization or venue invite code to switch.',
      );
    }

    const slug = this.slugify(dto.name);
    const existingSlug = await this.prisma.organization.findUnique({ where: { slug } });
    const uniqueSlug = existingSlug ? `${slug}-${Date.now().toString(36)}` : slug;

    const inviteCode =
      dto.type === OrganizationType.BUSINESS
        ? await generateUniqueInviteCodeAcrossTables(this.prisma)
        : undefined;

    return this.prisma.organization.create({
      data: {
        name: dto.name,
        type: dto.type,
        slug: uniqueSlug,
        inviteCode,
        members: {
          create: { userId, role: OrgMemberRole.OWNER },
        },
      },
      include: { members: true },
    });
  }

  /** Get user's organizations */
  async getMyOrganizations(userId: string) {
    return this.prisma.organizationMember.findMany({
      where: { userId },
      include: {
        organization: {
          include: { venues: true, _count: { select: { members: true } } },
        },
      },
    });
  }

  /** Ensure user has an org (create personal if none) - for legacy compatibility */
  /**
   * Возвращает организацию пользователя, если он в ней состоит, иначе null.
   * Пришло на смену ensureUserHasOrg, который при отсутствии членства СОЗДАВАЛ
   * персональную организацию — из-за этого они плодились по одной на человека.
   */
  async findUserOrgId(userId: string): Promise<string | null> {
    const member = await this.prisma.organizationMember.findUnique({
      where: { userId },
      select: { organizationId: true },
    });
    return member?.organizationId ?? null;
  }

  /** Check user belongs to this organization (single membership per user) */
  async userHasAccess(userId: string, organizationId: string): Promise<boolean> {
    const member = await this.prisma.organizationMember.findUnique({
      where: { userId },
    });
    return member?.organizationId === organizationId;
  }

  /** OWNER, MANAGER, or MEMBER may create venues for the organization */
  async canManageOrganizationVenues(
    userId: string,
    organizationId: string,
  ): Promise<boolean> {
    const member = await this.prisma.organizationMember.findUnique({
      where: { userId },
      select: { role: true, organizationId: true },
    });
    if (!member || member.organizationId !== organizationId) {
      return false;
    }
    return (
      member.role === OrgMemberRole.OWNER ||
      member.role === OrgMemberRole.MANAGER ||
      member.role === OrgMemberRole.MEMBER
    );
  }

  private slugify(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'org';
  }
}
