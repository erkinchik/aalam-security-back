import { Prisma } from '@prisma/client';

/**
 * Everything an operator's UI needs to act on a session: who raised it, and —
 * for VENUE alarms — how the response team actually gets into the building.
 * Shared so the pool, the accept response and the WS bootstrap all agree.
 */
export const OPERATOR_SESSION_INCLUDE = {
  user: { select: { id: true, email: true, role: true, displayName: true, phone: true } },
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
} satisfies Prisma.EmergencySessionInclude;
