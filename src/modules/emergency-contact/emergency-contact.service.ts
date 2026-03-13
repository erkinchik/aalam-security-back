import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateEmergencyContactDto } from './dto/create-emergency-contact.dto';

@Injectable()
export class EmergencyContactService {
  constructor(private readonly prisma: PrismaService) {}

  async create(userId: string, dto: CreateEmergencyContactDto) {
    return this.prisma.emergencyContact.create({
      data: {
        userId,
        name: dto.name,
        phone: dto.phone,
        email: dto.email,
        isTrusted: dto.isTrusted ?? false,
      },
    });
  }

  async listByUser(userId: string) {
    return this.prisma.emergencyContact.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async delete(userId: string, contactId: string) {
    const contact = await this.prisma.emergencyContact.findFirst({
      where: { id: contactId, userId },
    });
    if (!contact) throw new NotFoundException('Contact not found');
    await this.prisma.emergencyContact.delete({ where: { id: contactId } });
    return { status: 'ok' };
  }
}
