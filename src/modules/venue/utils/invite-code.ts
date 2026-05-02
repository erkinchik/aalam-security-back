import { ConflictException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import {
  generateInviteCode as generateInviteCodeCore,
  generateUniqueInviteCodeAcrossTables as generateUniqueInviteCodeAcrossTablesCore,
} from '../../../../prisma/lib/invite-code';

export function generateInviteCode(length = 6): string {
  return generateInviteCodeCore(length);
}

export async function generateUniqueInviteCodeAcrossTables(
  prisma: Pick<PrismaClient, 'venue' | 'organization'>,
  length = 6,
): Promise<string> {
  try {
    return await generateUniqueInviteCodeAcrossTablesCore(prisma, length);
  } catch {
    throw new ConflictException('Failed to generate unique invite code');
  }
}
