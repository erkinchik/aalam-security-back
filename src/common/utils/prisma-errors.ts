import { Prisma } from '@prisma/client';

/**
 * P2025 = "An operation failed because it depends on one or more records
 * that were required but not found." Prisma throws this when an `update`
 * (or `delete`) with a `where` clause matches zero rows — which is exactly
 * what we want as a concurrency signal when using `update` with extended
 * `where` conditions to do a conditional update.
 */
export function isPrismaRowNotFound(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025'
  );
}
