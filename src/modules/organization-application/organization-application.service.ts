import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateOrganizationApplicationDto } from './dto/create-organization-application.dto';

@Injectable()
export class OrganizationApplicationService {
  private readonly logger = new Logger(OrganizationApplicationService.name);

  constructor(private readonly prisma: PrismaService) {}

  async create(userId: string, dto: CreateOrganizationApplicationDto) {
    const branchesJson = dto.branches as unknown as Prisma.InputJsonValue;

    const created = await this.prisma.organizationApplication.create({
      data: {
        userId,
        organizationName: dto.organizationName,
        organizationType: dto.organizationType,
        branches: branchesJson,
        contactEmail: dto.contactEmail,
        contactPhone: dto.contactPhone,
        description: dto.description ?? null,
        attachments: dto.attachments?.length
          ? {
              create: dto.attachments.map((a) => ({
                fileName: a.fileName,
                mimeType: a.mimeType,
                sizeBytes: a.sizeBytes ?? null,
              })),
            }
          : undefined,
      },
      include: { attachments: true },
    });

    for (const att of created.attachments) {
      this.logger.log(
        `Organization application attachment recorded: applicationId=${created.id} fileName=${att.fileName} mimeType=${att.mimeType} sizeBytes=${att.sizeBytes ?? 'n/a'} (storage not implemented)`,
      );
    }

    return created;
  }
}
