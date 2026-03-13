import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateOrganizationDto } from './dto/create-organization.dto';
import { OrgMemberRole, OrganizationType } from '@prisma/client';

@Injectable()
export class OrganizationService {
  constructor(private readonly prisma: PrismaService) {}

  /** Create a personal organization for a new user (used during registration) */
  async createPersonalForUser(userId: string): Promise<{ id: string; slug: string }> {
    const slug = `personal-${userId.slice(0, 8)}`;
    const org = await this.prisma.organization.create({
      data: {
        name: 'My Account',
        type: OrganizationType.PERSONAL,
        slug,
        members: {
          create: {
            userId,
            role: OrgMemberRole.OWNER,
          },
        },
      },
    });
    return { id: org.id, slug: org.slug };
  }

  /** Create organization (for business signup) */
  async create(userId: string, dto: CreateOrganizationDto) {
    const slug = this.slugify(dto.name);
    const existingSlug = await this.prisma.organization.findUnique({ where: { slug } });
    const uniqueSlug = existingSlug ? `${slug}-${Date.now().toString(36)}` : slug;

    return this.prisma.organization.create({
      data: {
        name: dto.name,
        type: dto.type,
        slug: uniqueSlug,
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

  /** Get primary/default org for user (first one they own) */
  async getPrimaryOrgForUser(userId: string): Promise<string | null> {
    const member = await this.prisma.organizationMember.findFirst({
      where: { userId, role: OrgMemberRole.OWNER },
      select: { organizationId: true },
    });
    return member?.organizationId ?? null;
  }

  /** Ensure user has an org (create personal if none) - for legacy compatibility */
  async ensureUserHasOrg(userId: string): Promise<string> {
    const orgId = await this.getPrimaryOrgForUser(userId);
    if (orgId) return orgId;
    const { id } = await this.createPersonalForUser(userId);
    return id;
  }

  /** Check user has access to org */
  async userHasAccess(userId: string, organizationId: string): Promise<boolean> {
    const member = await this.prisma.organizationMember.findUnique({
      where: {
        userId_organizationId: { userId, organizationId },
      },
    });
    return !!member;
  }

  private slugify(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'org';
  }
}
