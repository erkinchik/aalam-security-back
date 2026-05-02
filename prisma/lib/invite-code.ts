import { PrismaClient } from '@prisma/client';

/** Readable chars excluding 0, O, I, 1, L */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Unique among both Venue.inviteCode and Organization.inviteCode (case-sensitive storage). */
export async function generateUniqueInviteCodeAcrossTables(
  prisma: Pick<PrismaClient, 'venue' | 'organization'>,
  length = 6,
): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const code = generateInviteCode(length);
    const [v, o] = await Promise.all([
      prisma.venue.findFirst({ where: { inviteCode: code } }),
      prisma.organization.findFirst({ where: { inviteCode: code } }),
    ]);
    if (!v && !o) return code;
  }
  throw new Error('Failed to generate unique invite code');
}

export function generateInviteCode(length = 6): string {
  let result = '';
  const bytes = new Uint8Array(length);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  for (let i = 0; i < length; i++) {
    result += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return result;
}
