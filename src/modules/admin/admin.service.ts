import {
  Injectable,
  ConflictException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import {
  OrgMemberRole,
  OrganizationApplicationStatus,
  OrganizationType,
  Role,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { generateInviteCode } from '../venue/utils/invite-code';
import { RedisService } from '../../redis/redis.service';
import { WebsocketGateway } from '../websocket/websocket.gateway';
import { PushService } from '../push/push.service';
import { CreateOperatorDto } from './dto/create-operator.dto';
import { CreateOrganizationDto } from './dto/create-organization.dto';
import { EmergenciesQueryDto } from './dto/emergencies-query.dto';
import { OrganizationApplicationsQueryDto } from './dto/organization-applications-query.dto';
import { ApproveOrganizationApplicationDto } from './dto/approve-organization-application.dto';
import { RejectOrganizationApplicationDto } from './dto/reject-organization-application.dto';

const HEARTBEAT_TTL_SECONDS = 30;
const ONLINE_THRESHOLD_MS = (HEARTBEAT_TTL_SECONDS + 5) * 1000;

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly wsGateway: WebsocketGateway,
    private readonly pushService: PushService,
  ) {}

  async getEmergencies(query: EmergenciesQueryDto) {
    const { status, organizationId, assigned, from, to, page = 1, limit = 20 } = query;

    const where: Record<string, unknown> = {};

    if (status) where.status = status;
    if (organizationId) where.organizationId = organizationId;

    if (assigned === true) {
      where.assignedOperatorId = { not: null };
    } else if (assigned === false) {
      where.assignedOperatorId = null;
    }

    if (from || to) {
      where.createdAt = {};
      if (from) (where.createdAt as Record<string, Date>).gte = new Date(from);
      if (to) (where.createdAt as Record<string, Date>).lte = new Date(to);
    }

    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      this.prisma.emergencySession.findMany({
        where,
        include: {
          user: { select: { id: true, email: true, role: true } },
          organization: { select: { id: true, name: true } },
          venue: { select: { id: true, name: true } },
          locations: { orderBy: { createdAt: 'desc' }, take: 1 },
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

  async getEmergencyById(id: string) {
    const session = await this.prisma.emergencySession.findUnique({
      where: { id },
      include: {
        user: { select: { id: true, email: true, role: true } },
        organization: { select: { id: true, name: true } },
        venue: { select: { id: true, name: true } },
        locations: { orderBy: { createdAt: 'desc' } },
        assignedOperator: { select: { id: true, email: true } },
      },
    });

    if (!session) {
      throw new NotFoundException('Session not found');
    }

    return session;
  }

  async assignSession(sessionId: string, operatorId: string) {
    const session = await this.prisma.emergencySession.findUnique({
      where: { id: sessionId },
    });

    if (!session) {
      throw new NotFoundException('Session not found');
    }

    if (session.status === 'CLOSED') {
      throw new ConflictException('Session is already closed');
    }

    const operator = await this.prisma.user.findUnique({
      where: { id: operatorId },
      select: { role: true },
    });
    if (!operator || operator.role !== 'OPERATOR') {
      throw new BadRequestException('User is not an operator');
    }

    const updated = await this.prisma.emergencySession.update({
      where: { id: sessionId },
      data: {
        assignedOperatorId: operatorId,
        status: 'ASSIGNED',
      },
      include: {
        user: { select: { id: true, email: true, role: true } },
        organization: { select: { id: true, name: true } },
        venue: { select: { id: true, name: true } },
        assignedOperator: { select: { id: true, email: true } },
      },
    });

    this.wsGateway.emitEmergencyAssigned(
      updated.userId,
      updated as unknown as Record<string, unknown>,
    );

    void this.pushService.sendAssignmentToOperator(sessionId, operatorId);

    return updated;
  }

  async reassignSession(sessionId: string, operatorId: string) {
    const session = await this.prisma.emergencySession.findUnique({
      where: { id: sessionId },
    });

    if (!session) {
      throw new NotFoundException('Session not found');
    }

    if (session.status === 'CLOSED') {
      throw new ConflictException('Session is already closed');
    }

    if (session.assignedOperatorId === operatorId) {
      throw new BadRequestException('Session is already assigned to this operator');
    }

    const operator = await this.prisma.user.findUnique({
      where: { id: operatorId },
      select: { role: true },
    });
    if (!operator || operator.role !== 'OPERATOR') {
      throw new BadRequestException('User is not an operator');
    }

    const updated = await this.prisma.emergencySession.update({
      where: { id: sessionId },
      data: {
        assignedOperatorId: operatorId,
        status: 'ASSIGNED',
      },
      include: {
        user: { select: { id: true, email: true, role: true } },
        organization: { select: { id: true, name: true } },
        venue: { select: { id: true, name: true } },
        assignedOperator: { select: { id: true, email: true } },
      },
    });

    this.wsGateway.emitEmergencyReassigned(updated as unknown as Record<string, unknown>);
    void this.pushService.sendAssignmentToOperator(sessionId, operatorId);

    return updated;
  }

  async unassignSession(sessionId: string) {
    const session = await this.prisma.emergencySession.findUnique({
      where: { id: sessionId },
    });

    if (!session) {
      throw new NotFoundException('Session not found');
    }

    if (session.status === 'CLOSED') {
      throw new ConflictException('Session is already closed');
    }

    const updated = await this.prisma.emergencySession.update({
      where: { id: sessionId },
      data: {
        assignedOperatorId: null,
        status: 'NEW',
      },
      include: {
        user: { select: { id: true, email: true, role: true } },
        organization: { select: { id: true, name: true } },
        venue: { select: { id: true, name: true } },
      },
    });

    this.wsGateway.emitEmergencyReassigned(updated as unknown as Record<string, unknown>);

    return updated;
  }

  async getOperators(organizationId?: string) {
    const where = {
      role: Role.OPERATOR,
      ...(organizationId && { orgMemberships: { some: { organizationId } } }),
    };

    const operators = await this.prisma.user.findMany({
      where,
      select: {
        id: true,
        email: true,
        orgMemberships: {
          where: { role: { in: ['OWNER', 'MANAGER', 'OPERATOR'] } },
          include: {
            organization: { select: { id: true, name: true } },
          },
        },
        _count: {
          select: {
            assignedSessions: {
              where: { status: { in: ['ASSIGNED', 'IN_PROGRESS'] } },
            },
          },
        },
      },
    });

    const operatorsWithOnline = await Promise.all(
      operators.map(async (op) => {
        const heartbeat = await this.redis.getOperatorHeartbeat(op.id);
        const lastHeartbeat = heartbeat ? parseInt(heartbeat, 10) : null;
        const isOnline =
          lastHeartbeat != null && Date.now() - lastHeartbeat < ONLINE_THRESHOLD_MS;
        const { _count, ...opData } = op;
        return {
          ...opData,
          isOnline,
          lastHeartbeatAt: lastHeartbeat ? new Date(lastHeartbeat) : null,
          activeSessionCount: _count.assignedSessions,
        };
      }),
    );

    return operatorsWithOnline;
  }

  async getOrganizations() {
    return this.prisma.organization.findMany({
      select: { id: true, name: true, slug: true, type: true },
      orderBy: { name: 'asc' },
    });
  }

  private organizationNameToSlug(name: string): string {
    return (
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || 'org'
    );
  }

  async createOrganization(dto: CreateOrganizationDto) {
    const slug = this.organizationNameToSlug(dto.name);
    const existing = await this.prisma.organization.findUnique({ where: { slug } });
    const uniqueSlug = existing ? `${slug}-${Date.now().toString(36)}` : slug;

    return this.prisma.organization.create({
      data: {
        name: dto.name,
        type: dto.type ?? 'BUSINESS',
        slug: uniqueSlug,
      },
    });
  }

  private parseApplicationBranches(branches: unknown): Array<{ name: string; address: string }> {
    if (!Array.isArray(branches) || branches.length === 0) {
      throw new BadRequestException('Application has no valid branches');
    }
    const out: Array<{ name: string; address: string }> = [];
    for (const item of branches) {
      const row = item as { name?: unknown; address?: unknown };
      if (typeof row?.name !== 'string' || !row.name.trim()) {
        throw new BadRequestException('Each branch must have a non-empty name');
      }
      const address = typeof row.address === 'string' ? row.address.trim() : '';
      out.push({ name: row.name.trim(), address });
    }
    return out;
  }

  private mapApplicationOrganizationType(
    organizationType: string,
    override?: OrganizationType,
  ): OrganizationType {
    if (override) return override;
    const u = organizationType.trim().toUpperCase();
    if (u === 'PERSONAL') return OrganizationType.PERSONAL;
    return OrganizationType.BUSINESS;
  }

  async getOrganizationApplications(query: OrganizationApplicationsQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const where: { status?: OrganizationApplicationStatus } = {};
    if (query.status != null) {
      where.status = query.status;
    }
    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      this.prisma.organizationApplication.findMany({
        where,
        include: {
          user: { select: { id: true, email: true } },
          approvedOrganization: { select: { id: true, name: true, slug: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      } as any),
      this.prisma.organizationApplication.count({ where }),
    ]);

    return { data, total, page, limit };
  }

  async getOrganizationApplicationById(id: string) {
    const application = await this.prisma.organizationApplication.findUnique({
      where: { id },
      include: {
        user: { select: { id: true, email: true } },
        attachments: true,
        approvedOrganization: { select: { id: true, name: true, slug: true, type: true } },
      },
    } as any);

    if (!application) {
      throw new NotFoundException('Application not found');
    }

    return application;
  }

  async approveOrganizationApplication(
    id: string,
    dto?: ApproveOrganizationApplicationDto,
  ) {
    const application = await this.prisma.organizationApplication.findUnique({
      where: { id },
    });

    if (!application) {
      throw new NotFoundException('Application not found');
    }

    if (application.status !== OrganizationApplicationStatus.PENDING) {
      throw new ConflictException(`Application is already ${application.status}`);
    }

    const branchRows = this.parseApplicationBranches(application.branches);
    const name =
      dto?.organizationName?.trim() || application.organizationName;
    const type = this.mapApplicationOrganizationType(
      application.organizationType,
      dto?.organizationType,
    );

    const slugBase = this.organizationNameToSlug(name);
    const existing = await this.prisma.organization.findUnique({
      where: { slug: slugBase },
    });
    const uniqueSlug = existing ? `${slugBase}-${Date.now().toString(36)}` : slugBase;

    return this.prisma.$transaction(async (tx) => {
      const org = await tx.organization.create({
        data: {
          name,
          type,
          slug: uniqueSlug,
        },
      });

      await tx.organizationMember.deleteMany({
        where: { userId: application.userId },
      });

      for (const br of branchRows) {
        let inviteCode = '';
        let codeOk = false;
        for (let attempt = 0; attempt < 10; attempt++) {
          inviteCode = generateInviteCode(6);
          const taken = await tx.venue.findFirst({ where: { inviteCode } });
          if (!taken) {
            codeOk = true;
            break;
          }
        }
        if (!codeOk) {
          throw new ConflictException('Failed to generate unique invite code');
        }

        await tx.venue.create({
          data: {
            organizationId: org.id,
            name: br.name,
            address: br.address || null,
            inviteCode,
          },
        });
      }

      await tx.organizationMember.create({
        data: {
          userId: application.userId,
          organizationId: org.id,
          role: OrgMemberRole.OWNER,
        },
      });

      return tx.organizationApplication.update({
        where: { id },
        data: {
          status: OrganizationApplicationStatus.APPROVED,
          approvedOrganizationId: org.id,
          rejectionReason: null,
        },
        include: {
          user: { select: { id: true, email: true } },
          attachments: true,
          approvedOrganization: {
            select: { id: true, name: true, slug: true, type: true },
          },
        },
      } as any);
    });
  }

  async rejectOrganizationApplication(
    id: string,
    dto?: RejectOrganizationApplicationDto,
  ) {
    const application = await this.prisma.organizationApplication.findUnique({
      where: { id },
    });

    if (!application) {
      throw new NotFoundException('Application not found');
    }

    if (application.status !== OrganizationApplicationStatus.PENDING) {
      throw new ConflictException(`Application is already ${application.status}`);
    }

    return this.prisma.organizationApplication.update({
      where: { id },
      data: {
        status: OrganizationApplicationStatus.REJECTED,
        rejectionReason: dto?.reason?.trim() || null,
      },
      include: {
        user: { select: { id: true, email: true } },
        attachments: true,
        approvedOrganization: { select: { id: true, name: true, slug: true, type: true } },
      },
    } as any);
  }

  async closeSessionAdmin(sessionId: string, resolution?: string) {
    const session = await this.prisma.emergencySession.findUnique({
      where: { id: sessionId },
    });

    if (!session) {
      throw new NotFoundException('Session not found');
    }

    if (session.status === 'CLOSED') {
      throw new ConflictException('Session is already closed');
    }

    const updated = await this.prisma.emergencySession.update({
      where: { id: sessionId },
      data: {
        status: 'CLOSED',
        closedAt: new Date(),
        resolution: resolution ?? 'Closed by admin',
        assignedOperatorId: null,
      },
      include: {
        user: { select: { id: true, email: true, role: true } },
        organization: { select: { id: true, name: true } },
        venue: { select: { id: true, name: true } },
      },
    });

    await this.redis.removeActiveEmergency(sessionId);
    this.wsGateway.emitEmergencyClosed(
      session.userId,
      updated as unknown as Record<string, unknown>,
    );

    return updated;
  }

  async createOperator(dto: CreateOperatorDto) {
    const existing = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });

    if (existing) {
      throw new ConflictException('Email already registered');
    }

    const hashedPassword = await bcrypt.hash(dto.password, 10);

    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        password: hashedPassword,
        role: 'OPERATOR',
      },
      select: {
        id: true,
        email: true,
        role: true,
        createdAt: true,
      },
    });

    return user;
  }
}
