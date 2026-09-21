import {
  Injectable,
  ConflictException,
  Logger,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import * as bcrypt from "bcryptjs";
import * as crypto from "crypto";
import {
  OrgMemberRole,
  OrganizationApplicationStatus,
  Prisma,
  Role,
  SubscriptionRequestStatus,
} from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { generateUniqueInviteCodeAcrossTables } from "../venue/utils/invite-code";
import { RedisService } from "../../redis/redis.service";
import { RefreshTokenService } from "../refresh-token/refresh-token.service";
import { WebsocketGateway } from "../websocket/websocket.gateway";
import { PushService } from "../push/push.service";
import { isPrismaRowNotFound } from "../../common/utils/prisma-errors";
import { ErrorCode } from "../../common/errors/error-codes";
import {
  badRequest,
  conflict,
  notFound,
} from "../../common/errors/app.exception";
import { anonymizedEmailFor } from "../../common/constants/anonymize";
import {
  isHeartbeatFresh,
  parseHeartbeat,
  ONLINE_THRESHOLD_MS,
  OPEN_ASSIGNED_STATUSES,
} from "../../common/constants/operator-presence";
import { CreateOperatorDto } from "./dto/create-operator.dto";
import { UpdateOperatorDto } from "./dto/update-operator.dto";
import { CreateOrganizationDto } from "./dto/create-organization.dto";
import { UpdateOrganizationDto } from "./dto/update-organization.dto";
import { AddOrganizationMemberDto } from "./dto/add-organization-member.dto";
import { UpdateOrganizationMemberDto } from "./dto/update-organization-member.dto";
import { EmergenciesQueryDto } from "./dto/emergencies-query.dto";
import { OrganizationApplicationsQueryDto } from "./dto/organization-applications-query.dto";
import { ApproveOrganizationApplicationDto } from "./dto/approve-organization-application.dto";
import { RejectOrganizationApplicationDto } from "./dto/reject-organization-application.dto";
import { SubscriptionRequestsQueryDto } from "./dto/subscription-requests-query.dto";
import { ApproveSubscriptionRequestDto } from "./dto/approve-subscription-request.dto";
import { RejectSubscriptionRequestDto } from "./dto/reject-subscription-request.dto";
import { CreateVenueDto } from "../venue/dto/create-venue.dto";
import { UpdateVenueDto } from "../venue/dto/update-venue.dto";

const BCRYPT_COST = 12;

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly wsGateway: WebsocketGateway,
    private readonly pushService: PushService,
    private readonly refreshTokens: RefreshTokenService,
  ) {}

  async getEmergencies(query: EmergenciesQueryDto) {
    const {
      status,
      organizationId,
      assigned,
      from,
      to,
      page = 1,
      limit = 20,
    } = query;

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
          locations: { orderBy: { createdAt: "desc" }, take: 1 },
          assignedOperator: { select: { id: true, email: true } },
        },
        orderBy: { createdAt: "desc" },
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
        locations: { orderBy: { createdAt: "desc" } },
        assignedOperator: { select: { id: true, email: true } },
      },
    });

    if (!session) {
      throw new NotFoundException("Session not found");
    }

    return session;
  }

  async assignSession(sessionId: string, operatorId: string) {
    await this.assertOperatorCanTakeSession(operatorId);

    try {
      // REL-1: conditional update — fails if session was closed concurrently.
      const updated = await this.prisma.emergencySession.update({
        where: { id: sessionId, status: { not: "CLOSED" } },
        data: {
          assignedOperatorId: operatorId,
          status: "ASSIGNED",
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
      this.wsGateway.emitPoolRemoved(sessionId);
      void this.pushService.sendAssignmentToOperator(sessionId, operatorId);
      return updated;
    } catch (err) {
      if (!isPrismaRowNotFound(err)) throw err;
      const existing = await this.prisma.emergencySession.findUnique({
        where: { id: sessionId },
        select: { status: true },
      });
      if (!existing) throw new NotFoundException("Session not found");
      throw new ConflictException(`Session is ${existing.status}`);
    }
  }

  async reassignSession(sessionId: string, operatorId: string) {
    await this.assertOperatorCanTakeSession(operatorId);
    // Прежний исполнитель нужен, чтобы сказать ему, что вызов ушёл. Условный
    // update вернёт уже новое состояние, поэтому читаем заранее. Гонка здесь
    // безобидна: в худшем случае уведомим того, кто и так потерял вызов.
    const before = await this.prisma.emergencySession.findUnique({
      where: { id: sessionId },
      select: { assignedOperatorId: true },
    });

    try {
      // REL-1: also rejects re-assignment to the same operator atomically.
      const updated = await this.prisma.emergencySession.update({
        where: {
          id: sessionId,
          status: { not: "CLOSED" },
          assignedOperatorId: { not: operatorId },
        },
        data: {
          assignedOperatorId: operatorId,
          status: "ASSIGNED",
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
        before?.assignedOperatorId,
      );
      void this.pushService.sendAssignmentToOperator(sessionId, operatorId);
      return updated;
    } catch (err) {
      if (!isPrismaRowNotFound(err)) throw err;
      const existing = await this.prisma.emergencySession.findUnique({
        where: { id: sessionId },
        select: { status: true, assignedOperatorId: true },
      });
      if (!existing) throw new NotFoundException("Session not found");
      if (existing.status === "CLOSED") {
        throw new ConflictException("Session is already closed");
      }
      if (existing.assignedOperatorId === operatorId) {
        throw new BadRequestException(
          "Session is already assigned to this operator",
        );
      }
      throw new ConflictException(`Session is ${existing.status}`);
    }
  }

  async unassignSession(sessionId: string) {
    const before = await this.prisma.emergencySession.findUnique({
      where: { id: sessionId },
      select: { assignedOperatorId: true },
    });
    try {
      const updated = await this.prisma.emergencySession.update({
        where: { id: sessionId, status: { not: "CLOSED" } },
        data: {
          assignedOperatorId: null,
          status: "NEW",
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
        before?.assignedOperatorId,
      );
      // Вызов снова свободен — предлагаем его дежурным, как обычный новый.
      void this.wsGateway.emitPoolReturned(
        updated as unknown as Record<string, unknown>,
      );
      return updated;
    } catch (err) {
      if (!isPrismaRowNotFound(err)) throw err;
      const existing = await this.prisma.emergencySession.findUnique({
        where: { id: sessionId },
        select: { status: true },
      });
      if (!existing) throw new NotFoundException("Session not found");
      throw new ConflictException("Session is already closed");
    }
  }

  /**
   * Operators are a single global pool — deliberately not scoped by
   * organization, so any of them can be put on any session.
   */
  /**
   * Оператор ведёт один вызов за раз: интерфейс показывает ровно одну карточку,
   * и второй назначенный вызов стал бы невидимым — при том что сдать смену с
   * ним нельзя. Удалённых в назначение тоже не пускаем.
   */
  private async assertOperatorCanTakeSession(operatorId: string) {
    const operator = await this.prisma.user.findUnique({
      where: { id: operatorId },
      select: { role: true, deletedAt: true },
    });
    if (!operator || operator.role !== Role.OPERATOR || operator.deletedAt) {
      throw badRequest(ErrorCode.NOT_AN_OPERATOR, "User is not an operator");
    }

    const openSessions = await this.prisma.emergencySession.count({
      where: {
        assignedOperatorId: operatorId,
        status: { in: OPEN_ASSIGNED_STATUSES },
      },
    });
    if (openSessions > 0) {
      throw conflict(
        ErrorCode.OPERATOR_BUSY,
        `Operator already has ${openSessions} open session(s)`,
        { openSessions },
      );
    }
  }

  async getOperators(page = 1, limit = 20) {
    // Мягко удалённые остаются в базе ради истории вызовов, но в списке им
    // не место: это анонимизированные строки без контактов.
    const where = { role: Role.OPERATOR, deletedAt: null };
    const skip = (page - 1) * limit;

    const [operators, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        select: {
          id: true,
          email: true,
          displayName: true,
          phone: true,
          onShift: true,
          shiftStartedAt: true,
          _count: {
            select: {
              assignedSessions: {
                where: { status: { in: OPEN_ASSIGNED_STATUSES } },
              },
            },
          },
        },
        orderBy: [{ onShift: "desc" }, { email: "asc" }],
        skip,
        take: limit,
      }),
      this.prisma.user.count({ where }),
    ]);

    const heartbeats = await this.redis.getOperatorHeartbeats(
      operators.map((op) => op.id),
    );
    const now = Date.now();

    const data = operators.map((op) => {
      const lastHeartbeat = heartbeats.get(op.id) ?? null;
      const { _count, ...opData } = op;
      return {
        ...opData,
        isOnline:
          lastHeartbeat != null && now - lastHeartbeat < ONLINE_THRESHOLD_MS,
        lastHeartbeatAt: lastHeartbeat ? new Date(lastHeartbeat) : null,
        activeSessionCount: _count.assignedSessions,
      };
    });

    return { data, total, page, limit };
  }

  /** Карточка одного оператора — то же, что в списке, плюс контакты и даты. */
  async getOperatorById(operatorId: string) {
    const operator = await this.prisma.user.findFirst({
      where: { id: operatorId, role: Role.OPERATOR, deletedAt: null },
      select: {
        id: true,
        email: true,
        displayName: true,
        phone: true,
        onShift: true,
        shiftStartedAt: true,
        createdAt: true,
        _count: {
          select: {
            assignedSessions: {
              where: { status: { in: OPEN_ASSIGNED_STATUSES } },
            },
          },
        },
      },
    });
    if (!operator) {
      throw notFound(ErrorCode.OPERATOR_NOT_FOUND, "Operator not found");
    }

    const heartbeat = await this.redis.getOperatorHeartbeat(operatorId);
    const { _count, ...data } = operator;
    return {
      ...data,
      isOnline: isHeartbeatFresh(heartbeat, ONLINE_THRESHOLD_MS),
      lastHeartbeatAt: parseHeartbeat(heartbeat)
        ? new Date(parseHeartbeat(heartbeat) as number)
        : null,
      activeSessionCount: _count.assignedSessions,
    };
  }

  async updateOperator(operatorId: string, dto: UpdateOperatorDto) {
    await this.assertOperatorExists(operatorId);

    if (dto.email) {
      const taken = await this.prisma.user.findFirst({
        where: { email: dto.email, NOT: { id: operatorId } },
        select: { id: true },
      });
      if (taken) {
        throw conflict(
          ErrorCode.EMAIL_ALREADY_REGISTERED,
          "Email already registered",
        );
      }
    }

    const updated = await this.prisma.user.update({
      where: { id: operatorId },
      data: {
        ...(dto.email ? { email: dto.email } : {}),
        ...(dto.displayName !== undefined
          ? { displayName: dto.displayName }
          : {}),
        ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
      },
      select: {
        id: true,
        email: true,
        displayName: true,
        phone: true,
        onShift: true,
        shiftStartedAt: true,
        createdAt: true,
      },
    });

    this.logger.log(`Admin updated operator ${operatorId}`);
    return updated;
  }

  /**
   * Смена пароля оператора администратором. Все refresh-токены отзываются,
   * иначе старая сессия на телефоне пережила бы смену пароля.
   */
  async setOperatorPassword(operatorId: string, password: string) {
    await this.assertOperatorExists(operatorId);

    const hashedPassword = await bcrypt.hash(password, BCRYPT_COST);
    await this.prisma.user.update({
      where: { id: operatorId },
      data: { password: hashedPassword },
    });
    await this.refreshTokens.removeAllForUser(operatorId);

    this.logger.log(`Admin reset password for operator ${operatorId}`);
    return { status: "ok" };
  }

  /**
   * Мягкое удаление оператора: строка остаётся, персональные данные стираются.
   * Жёсткое удаление либо упёрлось бы во внешний ключ EmergencySession, либо
   * обнулило бы исполнителя у всех прошлых вызовов — история перестала бы
   * отвечать на вопрос «кто вёл этот вызов».
   */
  async deleteOperator(operatorId: string) {
    await this.assertOperatorExists(operatorId);

    const openSessions = await this.prisma.emergencySession.count({
      where: {
        assignedOperatorId: operatorId,
        status: { in: OPEN_ASSIGNED_STATUSES },
      },
    });
    if (openSessions > 0) {
      throw conflict(
        ErrorCode.SHIFT_HAS_OPEN_SESSIONS,
        `Operator still has ${openSessions} open session(s)`,
        { openSessions },
      );
    }

    const wasOnShift = await this.prisma.user.findUnique({
      where: { id: operatorId },
      select: { onShift: true },
    });

    await this.prisma.$transaction(async (tx) => {
      await tx.organizationMember.deleteMany({ where: { userId: operatorId } });
      await tx.passwordResetToken.deleteMany({ where: { userId: operatorId } });
      await tx.user.update({
        where: { id: operatorId },
        data: {
          email: anonymizedEmailFor(operatorId),
          password: await bcrypt.hash(
            crypto.randomBytes(32).toString("hex"),
            BCRYPT_COST,
          ),
          displayName: null,
          phone: null,
          phoneVerifiedAt: null,
          pushToken: null,
          telegramId: null,
          telegramUsername: null,
          onShift: false,
          shiftStartedAt: null,
          deletedAt: new Date(),
        },
      });
    });

    await this.refreshTokens.removeAllForUser(operatorId);
    if (wasOnShift?.onShift) {
      this.wsGateway.emitShiftEnded(operatorId, "admin");
      await this.wsGateway.setOperatorShiftRoom(operatorId, false);
    }

    this.logger.log(`Admin soft-deleted operator ${operatorId}`);
    return { id: operatorId, deleted: true };
  }

  private async assertOperatorExists(operatorId: string) {
    const operator = await this.prisma.user.findFirst({
      where: { id: operatorId, role: Role.OPERATOR, deletedAt: null },
      select: { id: true },
    });
    if (!operator) {
      throw notFound(ErrorCode.OPERATOR_NOT_FOUND, "Operator not found");
    }
  }

  /**
   * Admin override of an operator's shift. Ending it obeys the same rule the
   * operator faces: open sessions must be dealt with first, otherwise they'd
   * be stranded on someone who no longer receives anything.
   */
  async setOperatorShift(operatorId: string, onShift: boolean) {
    const operator = await this.prisma.user.findUnique({
      where: { id: operatorId },
      select: { role: true },
    });
    if (!operator || operator.role !== Role.OPERATOR) {
      throw new BadRequestException("User is not an operator");
    }

    if (!onShift) {
      const activeSessionCount = await this.prisma.emergencySession.count({
        where: {
          assignedOperatorId: operatorId,
          status: { in: OPEN_ASSIGNED_STATUSES },
        },
      });
      if (activeSessionCount > 0) {
        throw new ConflictException(
          `У оператора ${activeSessionCount} незакрытых вызовов. ` +
            "Переназначьте или закройте их перед снятием со смены.",
        );
      }
    }

    const updated = await this.prisma.user.update({
      where: { id: operatorId },
      data: {
        onShift,
        shiftStartedAt: onShift ? new Date() : null,
      },
      select: { id: true, email: true, onShift: true, shiftStartedAt: true },
    });
    if (!onShift) this.wsGateway.emitShiftEnded(operatorId, "admin");
    await this.wsGateway.setOperatorShiftRoom(operatorId, onShift);

    this.logger.log(
      `Admin set operator ${operatorId} shift to ${onShift ? "ON" : "OFF"}`,
    );
    return updated;
  }

  async getOrganizations(page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      this.prisma.organization.findMany({
        select: { id: true, name: true, slug: true },
        orderBy: { name: "asc" },
        skip,
        take: limit,
      }),
      this.prisma.organization.count(),
    ]);
    return { data, total, page, limit };
  }

  async getOrganizationById(id: string) {
    const organization = await this.prisma.organization.findUnique({
      where: { id },
      include: {
        venues: {
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
            inviteCode: true,
            createdAt: true,
          },
          orderBy: { createdAt: "asc" },
        },
        members: {
          select: {
            id: true,
            role: true,
            createdAt: true,
            user: { select: { id: true, email: true, role: true } },
            venue: { select: { id: true, name: true } },
          },
          orderBy: { createdAt: "asc" },
        },
      },
    });

    if (!organization) {
      throw new NotFoundException("Organization not found");
    }

    return organization;
  }

  private organizationNameToSlug(name: string): string {
    return (
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") || "org"
    );
  }

  async createOrganization(dto: CreateOrganizationDto) {
    const slug = this.organizationNameToSlug(dto.name);
    const existing = await this.prisma.organization.findUnique({
      where: { slug },
    });
    const uniqueSlug = existing ? `${slug}-${Date.now().toString(36)}` : slug;
    const inviteCode = await generateUniqueInviteCodeAcrossTables(this.prisma);

    return this.prisma.organization.create({
      data: {
        name: dto.name,
        slug: uniqueSlug,
        inviteCode,
      },
    });
  }

  private parseApplicationBranches(
    branches: unknown,
  ): Array<{
    name: string;
    address: string;
    latitude: number | null;
    longitude: number | null;
  }> {
    if (!Array.isArray(branches) || branches.length === 0) {
      throw new BadRequestException("Application has no valid branches");
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
      if (typeof row?.name !== "string" || !row.name.trim()) {
        throw new BadRequestException("Each branch must have a non-empty name");
      }
      const address = typeof row.address === "string" ? row.address.trim() : "";
      const latitude =
        typeof row.latitude === "number" && Number.isFinite(row.latitude)
          ? row.latitude
          : null;
      const longitude =
        typeof row.longitude === "number" && Number.isFinite(row.longitude)
          ? row.longitude
          : null;
      out.push({ name: row.name.trim(), address, latitude, longitude });
    }
    return out;
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
          approvedOrganization: {
            select: { id: true, name: true, slug: true },
          },
        },
        orderBy: { createdAt: "desc" },
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
        approvedOrganization: {
          select: { id: true, name: true, slug: true },
        },
      },
    } as any);

    if (!application) {
      throw new NotFoundException("Application not found");
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
      throw new NotFoundException("Application not found");
    }
    if (application.status !== OrganizationApplicationStatus.PENDING) {
      throw new ConflictException(
        `Application is already ${application.status}`,
      );
    }

    const branchRows = this.parseApplicationBranches(application.branches);
    const name = dto?.organizationName?.trim() || application.organizationName;
    const slugBase = this.organizationNameToSlug(name);
    const existing = await this.prisma.organization.findUnique({
      where: { slug: slugBase },
    });
    const uniqueSlug = existing
      ? `${slugBase}-${Date.now().toString(36)}`
      : slugBase;

    try {
      return await this.prisma.$transaction(async (tx) => {
        const orgInviteCode = await generateUniqueInviteCodeAcrossTables(tx);
        const org = await tx.organization.create({
          data: {
            name,
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
              select: { id: true, name: true, slug: true },
            },
          },
        } as any);
      });
    } catch (err) {
      if (isPrismaRowNotFound(err)) {
        throw new ConflictException(
          "Application was changed by another admin (no longer PENDING)",
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
            select: { id: true, name: true, slug: true },
          },
        },
      } as any);
    } catch (err) {
      if (!isPrismaRowNotFound(err)) throw err;
      const existing = await this.prisma.organizationApplication.findUnique({
        where: { id },
        select: { status: true },
      });
      if (!existing) throw new NotFoundException("Application not found");
      throw new ConflictException(`Application is already ${existing.status}`);
    }
  }

  async closeSessionAdmin(sessionId: string, resolution?: string) {
    // Обновление обнуляет assignedOperatorId, поэтому исполнителя запоминаем
    // заранее — иначе оператор, который вёл вызов, не узнает о закрытии.
    const before = await this.prisma.emergencySession.findUnique({
      where: { id: sessionId },
      select: { assignedOperatorId: true },
    });
    try {
      const updated = await this.prisma.emergencySession.update({
        where: { id: sessionId, status: { not: "CLOSED" } },
        data: {
          status: "CLOSED",
          closedAt: new Date(),
          resolution: resolution ?? "Closed by admin",
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

      this.wsGateway.emitEmergencyClosed(
        updated.userId,
        updated as unknown as Record<string, unknown>,
        before?.assignedOperatorId,
      );
      this.wsGateway.emitPoolRemoved(sessionId);
      return updated;
    } catch (err) {
      if (!isPrismaRowNotFound(err)) throw err;
      const existing = await this.prisma.emergencySession.findUnique({
        where: { id: sessionId },
        select: { status: true },
      });
      if (!existing) throw new NotFoundException("Session not found");
      throw new ConflictException("Session is already closed");
    }
  }

  async createOperator(dto: CreateOperatorDto) {
    const existing = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });

    if (existing) {
      throw new ConflictException("Email already registered");
    }

    const hashedPassword = await bcrypt.hash(dto.password, BCRYPT_COST);

    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        password: hashedPassword,
        role: "OPERATOR",
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
        orderBy: { createdAt: "desc" },
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
      throw new NotFoundException("Subscription request not found");
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
      throw new BadRequestException("Invalid expiresAt");
    }
    if (expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException("expiresAt must be in the future");
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
          throw new NotFoundException("Subscription request not found");
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
      "approved",
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
          throw new NotFoundException("Subscription request not found");
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
      "rejected",
      { requestId: rejected.id, reason: rejected.rejectionReason },
    );

    return this.getSubscriptionRequestById(rejected.id);
  }

  // -------------------- Venues (admin) --------------------

  async createVenue(organizationId: string, dto: CreateVenueDto) {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { id: true },
    });
    if (!org) {
      throw new NotFoundException("Organization not found");
    }

    const inviteCode = await generateUniqueInviteCodeAcrossTables(this.prisma);

    const venue = await this.prisma.venue.create({
      data: {
        organizationId,
        name: dto.name,
        address: dto.address ?? null,
        apartment: dto.apartment ?? null,
        floor: dto.floor ?? null,
        entrance: dto.entrance ?? null,
        doorCode: dto.doorCode ?? null,
        addressNotes: dto.addressNotes ?? null,
        latitude: dto.latitude ?? null,
        longitude: dto.longitude ?? null,
        inviteCode,
      },
    });

    this.logger.log(
      `Venue created by admin: venueId=${venue.id} orgId=${organizationId} name="${venue.name}"`,
    );
    return venue;
  }

  async updateVenue(venueId: string, dto: UpdateVenueDto) {
    const venue = await this.prisma.venue.findUnique({
      where: { id: venueId },
      select: { id: true },
    });
    if (!venue) {
      throw new NotFoundException("Venue not found");
    }

    const data: Prisma.VenueUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.address !== undefined) data.address = dto.address;
    if (dto.apartment !== undefined) data.apartment = dto.apartment;
    if (dto.floor !== undefined) data.floor = dto.floor;
    if (dto.entrance !== undefined) data.entrance = dto.entrance;
    if (dto.doorCode !== undefined) data.doorCode = dto.doorCode;
    if (dto.addressNotes !== undefined) data.addressNotes = dto.addressNotes;
    if (dto.latitude !== undefined) data.latitude = dto.latitude;
    if (dto.longitude !== undefined) data.longitude = dto.longitude;

    const updated = await this.prisma.venue.update({
      where: { id: venueId },
      data,
    });

    this.logger.log(`Venue updated by admin: venueId=${venueId}`);
    return updated;
  }

  async deleteVenue(venueId: string) {
    const venue = await this.prisma.venue.findUnique({
      where: { id: venueId },
      select: { id: true, name: true, organizationId: true },
    });
    if (!venue) {
      throw new NotFoundException("Venue not found");
    }

    // EmergencySession.venueId и OrganizationMember.venueId — onDelete: SetNull
    // в schema.prisma, поэтому исторические сессии и членства не каскадятся.
    await this.prisma.venue.delete({ where: { id: venueId } });

    this.logger.warn(
      `Venue deleted by admin: venueId=${venueId} orgId=${venue.organizationId} name="${venue.name}"`,
    );
    return { status: "ok" };
  }

  // -------------------- Organization members (admin) --------------------

  async updateOrganization(id: string, dto: UpdateOrganizationDto) {
    const org = await this.prisma.organization.findUnique({ where: { id } });
    if (!org) throw new NotFoundException("Организация не найдена");

    // Без кода приглашения сотрудников не позвать, а поле уникальное —
    // генерируем только когда его ещё нет.
    const needsInviteCode = !org.inviteCode;

    return this.prisma.organization.update({
      where: { id },
      data: {
        ...(dto.name ? { name: dto.name } : {}),
        ...(needsInviteCode
          ? {
              inviteCode: await generateUniqueInviteCodeAcrossTables(
                this.prisma,
              ),
            }
          : {}),
      },
    });
  }

  async deleteOrganization(id: string) {
    const org = await this.prisma.organization.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        _count: { select: { members: true, venues: true } },
      },
    });
    if (!org) throw new NotFoundException("Организация не найдена");

    // Незакрытая тревога важнее любой уборки: удаление оборвало бы её на ходу.
    const openSessions = await this.prisma.emergencySession.count({
      where: { organizationId: id, closedAt: null },
    });
    if (openSessions > 0) {
      throw new ConflictException(
        `Нельзя удалить: в организации ${openSessions} незакрытых вызовов. Закройте их сначала.`,
      );
    }

    // Участники и объекты уходят каскадом (onDelete: Cascade), у исторических
    // вызовов organizationId станет NULL (SetNull) — история не пропадёт.
    await this.prisma.organization.delete({ where: { id } });

    this.logger.warn(
      `Organization deleted by admin: orgId=${id} name="${org.name}" ` +
        `members=${org._count.members} venues=${org._count.venues}`,
    );
    return { id, deleted: true };
  }

  async addOrganizationMember(
    organizationId: string,
    dto: AddOrganizationMemberDto,
  ) {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
    });
    if (!org) throw new NotFoundException("Организация не найдена");

    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });
    if (!user)
      throw new NotFoundException(`Пользователь ${dto.email} не найден`);

    // OrganizationMember.@@unique([userId]) — членство одно на человека.
    const existing = await this.prisma.organizationMember.findUnique({
      where: { userId: user.id },
      include: { organization: { select: { name: true } } },
    });
    if (existing) {
      throw new ConflictException(
        existing.organizationId === organizationId
          ? `${dto.email} уже состоит в этой организации`
          : `${dto.email} уже состоит в организации «${existing.organization.name}». Сначала уберите его оттуда.`,
      );
    }

    await this.assertVenueBelongsToOrg(dto.venueId, organizationId);

    return this.prisma.$transaction(async (tx) => {
      // Владелец в организации один: назначая нового, прежнего переводим в
      // менеджеры, иначе получилось бы два владельца.
      if (dto.role === OrgMemberRole.OWNER) {
        await this.demoteCurrentOwner(tx, organizationId);
      }
      return tx.organizationMember.create({
        data: {
          userId: user.id,
          organizationId,
          role: dto.role,
          venueId: dto.venueId ?? null,
        },
        include: {
          user: { select: { id: true, email: true, phone: true } },
          venue: { select: { id: true, name: true } },
        },
      });
    });
  }

  async updateOrganizationMember(
    memberId: string,
    dto: UpdateOrganizationMemberDto,
  ) {
    const member = await this.prisma.organizationMember.findUnique({
      where: { id: memberId },
      include: { user: { select: { email: true } } },
    });
    if (!member) throw new NotFoundException("Участник не найден");

    if (dto.venueId !== undefined && dto.venueId !== null) {
      await this.assertVenueBelongsToOrg(dto.venueId, member.organizationId);
    }

    return this.prisma.$transaction(async (tx) => {
      if (
        dto.role === OrgMemberRole.OWNER &&
        member.role !== OrgMemberRole.OWNER
      ) {
        await this.demoteCurrentOwner(tx, member.organizationId);
      }
      // Организация без владельца остаётся неуправляемой — понижать
      // единственного владельца запрещаем.
      if (
        member.role === OrgMemberRole.OWNER &&
        dto.role &&
        dto.role !== OrgMemberRole.OWNER
      ) {
        throw new ConflictException(
          "Нельзя снять роль с единственного владельца. Сначала назначьте владельцем другого участника.",
        );
      }
      return tx.organizationMember.update({
        where: { id: memberId },
        data: {
          ...(dto.role ? { role: dto.role } : {}),
          ...(dto.venueId !== undefined ? { venueId: dto.venueId } : {}),
        },
        include: {
          user: { select: { id: true, email: true, phone: true } },
          venue: { select: { id: true, name: true } },
        },
      });
    });
  }

  /** Объект должен принадлежать той же организации, иначе привязка бессмысленна. */
  private async assertVenueBelongsToOrg(
    venueId: string | undefined,
    organizationId: string,
  ) {
    if (!venueId) return;
    const venue = await this.prisma.venue.findUnique({
      where: { id: venueId },
      select: { organizationId: true },
    });
    if (!venue) throw new NotFoundException("Объект не найден");
    if (venue.organizationId !== organizationId) {
      throw new ConflictException("Объект принадлежит другой организации");
    }
  }

  private async demoteCurrentOwner(
    tx: Prisma.TransactionClient,
    organizationId: string,
  ): Promise<void> {
    const current = await tx.organizationMember.findFirst({
      where: { organizationId, role: OrgMemberRole.OWNER },
    });
    if (!current) return;
    await tx.organizationMember.update({
      where: { id: current.id },
      data: { role: OrgMemberRole.MANAGER },
    });
    this.logger.warn(
      `Ownership transferred: orgId=${organizationId} previousOwnerMemberId=${current.id} -> MANAGER`,
    );
  }

  async removeOrganizationMember(memberId: string) {
    const member = await this.prisma.organizationMember.findUnique({
      where: { id: memberId },
      select: { id: true, role: true, userId: true, organizationId: true },
    });
    if (!member) {
      throw new NotFoundException("Member not found");
    }
    if (member.role === OrgMemberRole.OWNER) {
      throw new ConflictException(
        "Нельзя убрать владельца. Сначала назначьте другого участника владельцем.",
      );
    }

    await this.prisma.organizationMember.delete({ where: { id: memberId } });

    this.logger.warn(
      `Organization member removed by admin: memberId=${memberId} orgId=${member.organizationId} userId=${member.userId}`,
    );
    return { status: "ok" };
  }
}
