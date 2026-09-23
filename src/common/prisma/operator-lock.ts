import { Prisma } from '@prisma/client';

/**
 * Serializes "does this operator already have an open call?" with the write
 * that gives them one. Without it two accepts for different sessions (or an
 * accept racing an admin assign) both counted zero open calls and both won,
 * leaving the operator with two calls the app can show only one of.
 *
 * Must run inside an interactive transaction, before the count. The row lock is
 * held until commit, so the second caller waits and then sees the first call.
 */
export async function lockOperatorRow(
  tx: Prisma.TransactionClient,
  operatorId: string,
): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${operatorId} FOR UPDATE`;
}
