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
  SubscriptionRequestStatus,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { generateUniqueInviteCodeAcrossTables } from '../venue/utils/invite-code';
import { RedisService } from '../../redis/redis.service';
import { WebsocketGateway } from '../websocket/websocket.gateway';
import { PushService } from '../push/push.service';
import { isPrismaRowNotFound } from '../../common/utils/prisma-errors';

const BCRYPT_COST = 12;
import { CreateOperatorDto } from './dto/create-operator.dto';
import { CreateOrganizationDto } from './dto/create-organization.dto';
import { EmergenciesQueryDto } from './dto/emergencies-query.dto';
import { OrganizationApplicationsQueryDto } from './dto/organization-applications-query.dto';
import { ApproveOrganizationApplicationDto } from './dto/approve-organization-application.dto';
import { RejectOrganizationApplicationDto } from './dto/reject-organization-application.dto';
import { SubscriptionRequestsQueryDto } from './dto/subscription-requests-query.dto';
import { ApproveSubscriptionRequestDto } from './dto/approve-subscription-request.dto';
import { RejectSubscriptionRequestDto } from './dto/reject-subscription-request.dto';

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
    const operator = await this.prisma.user.findUnique({
      where: { id: operatorId },
      select: { role: true },
    });
    if (!operator || operator.role !== 'OPERATOR') {
      throw new BadRequestException('User is not an operator');
    }

    try {
      // REL-1: conditional update — fails if session was closed concurrently.
      const updated = await this.prisma.emergencySession.update({
        where: { id: sessionId, status: { not: 'CLOSED' } },
        data: {
          assignedOperatorId: operatorId,
          status: 'ASSIGNED',
        },
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
          assignedOperator: { select: { id: true, email: true } },
        },
      });

      this.wsGateway.emitEmergencyAssigned(
        updated.userId,
        updated as unknown as Record<string, unknown>,
      );
      void this.pushService.sendAssignmentToOperator(sessionId, operatorId);
      return updated;
    } catch (err) {
      if (!isPrismaRowNotFound(err)) throw err;
      const existing = await this.prisma.emergencySession.findUnique({
        where: { id: sessionId },
        select: { status: true },
      });
      if (!existing) throw new NotFoundException('Session not found');
      throw new ConflictException(`Session is ${existing.status}`);
    }
  }

  async reassignSession(sessionId: string, operatorId: string) {
    const operator = await this.prisma.user.findUnique({
      where: { id: operatorId },
      select: { role: true },
    });
    if (!operator || operator.role !== 'OPERATOR') {
      throw new BadRequestException('User is not an operator');
    }

    try {
      // REL-1: also rejects re-assignment to the same operator atomically.
      const updated = await this.prisma.emergencySession.update({
        where: {
          id: sessionId,
          status: { not: 'CLOSED' },
          assignedOperatorId: { not: operatorId },
        },
        data: {
          assignedOperatorId: operatorId,
          status: 'ASSIGNED',
        },
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
          assignedOperator: { select: { id: true, email: true } },
        },
      });

      this.wsGateway.emitEmergencyReassigned(
        updated as unknown as Record<string, unknown>,
      );
      void this.pushService.sendAssignmentToOperator(sessionId, operatorId);
      return updated;
    } catch (err) {
      if (!isPrismaRowNotFound(err)) throw err;
      const existing = await this.prisma.emergencySession.findUnique({
        where: { id: sessionId },
        select: { status: true, assignedOperatorId: true },
      });
      if (!existing) throw new NotFoundException('Session not found');
      if (existing.status === 'CLOSED') {
        throw new ConflictException('Session is already closed');
      }
      if (existing.assignedOperatorId === operatorId) {
        throw new BadRequestException(
          'Session is already assigned to this operator',
        );
      }
      throw new ConflictException(`Session is ${existing.status}`);
    }
  }

  async unassignSession(sessionId: string) {
    try {
      const updated = await this.prisma.emergencySession.update({
        where: { id: sessionId, status: { not: 'CLOSED' } },
        data: {
          assignedOperatorId: null,
          status: 'NEW',
        },
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
        },
      });

      this.wsGateway.emitEmergencyReassigned(
        updated as unknown as Record<string, unknown>,
      );
      return updated;
    } catch (err) {
      if (!isPrismaRowNotFound(err)) throw err;
      const existing = await this.prisma.emergencySession.findUnique({
        where: { id: sessionId },
        select: { status: true },
      });
      if (!existing) throw new NotFoundException('Session not found');
      throw new ConflictException('Session is already closed');
    }
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
    const type = dto.type ?? OrganizationType.BUSINESS;
    const inviteCode =
      type === OrganizationType.BUSINESS
        ? await generateUniqueInviteCodeAcrossTables(this.prisma)
        : undefined;

    return this.prisma.organization.create({
      data: {
        name: dto.name,
        type,
        slug: uniqueSlug,
        inviteCode,
      },
    });
  }

  private parseApplicationBranches(
    branches: unknown,
  ): Array<{ name: string; address: string; latitude: number | null; longitude: number | null }> {
    if (!Array.isArray(branches) || branches.length === 0) {
      throw new BadRequestException('Application has no valid branches');
    }
    const out: Array<{
      name: string;
      address: string;
      latitude: number | null;
      longitude: number | null;
    }> = [];
    for (const item of branches) {
      const row = item as {
        name?: unknown;
        address?: unknown;
        latitude?: unknown;
        longitude?: unknown;
      };
      if (typeof row?.name !== 'string' || !row.name.trim()) {
        throw new BadRequestException('Each branch must have a non-empty name');
      }
      const address = typeof row.address === 'string' ? row.address.trim() : '';
      const latitude =
        typeof row.latitude === 'number' && Number.isFinite(row.latitude)
          ? row.latitude
          : null;
      const longitude =
        typeof row.longitude === 'number' && Number.isFinite(row.longitude)
          ? row.longitude
          : null;
      out.push({ name: row.name.trim(), address, latitude, longitude });
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
    // We still need basic data outside the transaction to compute the slug;
    // the atomic guarantee comes from the conditional update at the end.
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

    try {
      return await this.prisma.$transaction(async (tx) => {
        const orgInviteCode = await generateUniqueInviteCodeAcrossTables(tx);
        const org = await tx.organization.create({
          data: {
            name,
            type,
            slug: uniqueSlug,
            inviteCode: orgInviteCode,
          },
        });

        await tx.organizationMember.deleteMany({
          where: { userId: application.userId },
        });

        for (const br of branchRows) {
          const inviteCode = await generateUniqueInviteCodeAcrossTables(tx);

          await tx.venue.create({
            data: {
              organizationId: org.id,
              name: br.name,
              address: br.address || null,
              latitude: br.latitude,
              longitude: br.longitude,
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

        // REL-4: conditional final update inside the transaction. If another
        // admin already approved/rejected this application after the initial
        // read, P2025 fires and the whole transaction (org + venues + member)
        // is rolled back — no orphaned org leak.
        return tx.organizationApplication.update({
          where: {
            id,
            status: OrganizationApplicationStatus.PENDING,
          },
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
    } catch (err) {
      if (isPrismaRowNotFound(err)) {
        throw new ConflictException(
          'Application was changed by another admin (no longer PENDING)',
        );
      }
      throw err;
    }
  }

  async rejectOrganizationApplication(
    id: string,
    dto?: RejectOrganizationApplicationDto,
  ) {
    try {
      // REL-4: conditional update — fails with P2025 if another admin already
      // decided this application.
      return await this.prisma.organizationApplication.update({
        where: { id, status: OrganizationApplicationStatus.PENDING },
        data: {
          status: OrganizationApplicationStatus.REJECTED,
          rejectionReason: dto?.reason?.trim() || null,
        },
        include: {
          user: { select: { id: true, email: true } },
          attachments: true,
          approvedOrganization: {
            select: { id: true, name: true, slug: true, type: true },
          },
        },
      } as any);
    } catch (err) {
      if (!isPrismaRowNotFound(err)) throw err;
      const existing = await this.prisma.organizationApplication.findUnique({
        where: { id },
        select: { status: true },
      });
      if (!existing) throw new NotFoundException('Application not found');
      throw new ConflictException(`Application is already ${existing.status}`);
    }
  }

  async closeSessionAdmin(sessionId: string, resolution?: string) {
    try {
      const updated = await this.prisma.emergencySession.update({
        where: { id: sessionId, status: { not: 'CLOSED' } },
        data: {
          status: 'CLOSED',
          closedAt: new Date(),
          resolution: resolution ?? 'Closed by admin',
          assignedOperatorId: null,
        },
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
        },
      });

      await this.redis.removeActiveEmergency(sessionId);
      this.wsGateway.emitEmergencyClosed(
        updated.userId,
        updated as unknown as Record<string, unknown>,
      );
      return updated;
    } catch (err) {
      if (!isPrismaRowNotFound(err)) throw err;
      const existing = await this.prisma.emergencySession.findUnique({
        where: { id: sessionId },
        select: { status: true },
      });
      if (!existing) throw new NotFoundException('Session not found');
      throw new ConflictException('Session is already closed');
    }
  }

  async createOperator(dto: CreateOperatorDto) {
    const existing = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });

    if (existing) {
      throw new ConflictException('Email already registered');
    }

    const hashedPassword = await bcrypt.hash(dto.password, BCRYPT_COST);

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

  // -------------------- Subscription requests --------------------

  async getSubscriptionRequests(query: SubscriptionRequestsQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const where: { status?: SubscriptionRequestStatus } = {};
    if (query.status != null) {
      where.status = query.status;
    }
    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      this.prisma.subscriptionRequest.findMany({
        where,
        include: {
          user: {
            select: { id: true, email: true, phone: true, displayName: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.subscriptionRequest.count({ where }),
    ]);

    return { data, total, page, limit };
  }

  async getSubscriptionRequestById(id: string) {
    const request = await this.prisma.subscriptionRequest.findUnique({
      where: { id },
      include: {
        user: {
          select: { id: true, email: true, phone: true, displayName: true },
        },
      },
    });
    if (!request) {
      throw new NotFoundException('Subscription request not found');
    }
    let approvedByUser: { id: string; email: string } | null = null;
    if (request.approvedBy) {
      approvedByUser = await this.prisma.user.findUnique({
        where: { id: request.approvedBy },
        select: { id: true, email: true },
      });
    }
    return { ...request, approvedByUser };
  }

  async approveSubscriptionRequest(
    id: string,
    adminId: string,
    dto?: ApproveSubscriptionRequestDto,
  ) {
    const expiresAt = dto?.expiresAt
      ? new Date(dto.expiresAt)
      : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    if (Number.isNaN(expiresAt.getTime())) {
      throw new BadRequestException('Invalid expiresAt');
    }
    if (expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException('expiresAt must be in the future');
    }

    let approved;
    try {
      approved = await this.prisma.$transaction(async (tx) => {
        // REL-4: conditional update — fails with P2025 if another admin already
        // decided the request.
        const req = await tx.subscriptionRequest.update({
          where: { id, status: SubscriptionRequestStatus.PENDING },
          data: {
            status: SubscriptionRequestStatus.APPROVED,
            approvedBy: adminId,
            approvedAt: new Date(),
            expiresAt,
            rejectionReason: null,
          },
        });

        await tx.user.update({
          where: { id: req.userId },
          data: {
            individualSubscriptionActive: true,
            subscriptionExpiresAt: expiresAt,
          },
        });

        return req;
      });
    } catch (err) {
      if (isPrismaRowNotFound(err)) {
        const existing = await this.prisma.subscriptionRequest.findUnique({
          where: { id },
          select: { status: true },
        });
        if (!existing) {
          throw new NotFoundException('Subscription request not found');
        }
        throw new ConflictException(
          `Subscription request is already ${existing.status}`,
        );
      }
      throw err;
    }

    // Notify outside the transaction. Failures here must not roll back approval.
    this.wsGateway.emitSubscriptionApproved(approved.userId, {
      requestId: approved.id,
      expiresAt: approved.expiresAt,
    });
    void this.pushService.sendSubscriptionDecision(
      approved.userId,
      'approved',
      { requestId: approved.id, expiresAt: approved.expiresAt },
    );

    return this.getSubscriptionRequestById(approved.id);
  }

  async rejectSubscriptionRequest(
    id: string,
    dto?: RejectSubscriptionRequestDto,
  ) {
    let rejected;
    try {
      rejected = await this.prisma.subscriptionRequest.update({
        where: { id, status: SubscriptionRequestStatus.PENDING },
        data: {
          status: SubscriptionRequestStatus.REJECTED,
          rejectionReason: dto?.rejectionReason?.trim() || null,
        },
      });
    } catch (err) {
      if (isPrismaRowNotFound(err)) {
        const existing = await this.prisma.subscriptionRequest.findUnique({
          where: { id },
          select: { status: true },
        });
        if (!existing) {
          throw new NotFoundException('Subscription request not found');
        }
        throw new ConflictException(
          `Subscription request is already ${existing.status}`,
        );
      }
      throw err;
    }

    this.wsGateway.emitSubscriptionRejected(rejected.userId, {
      requestId: rejected.id,
      reason: rejected.rejectionReason,
    });
    void this.pushService.sendSubscriptionDecision(
      rejected.userId,
      'rejected',
      { requestId: rejected.id, reason: rejected.rejectionReason },
    );

    return this.getSubscriptionRequestById(rejected.id);
  }
}
