import { PrismaClient, OrgMemberRole, OrganizationType } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { generateUniqueInviteCodeAcrossTables } from './lib/invite-code';

const prisma = new PrismaClient();

async function backfillBusinessOrgInviteCodes() {
  const missing = await prisma.organization.findMany({
    where: { type: OrganizationType.BUSINESS, inviteCode: null },
  });
  for (const org of missing) {
    const code = await generateUniqueInviteCodeAcrossTables(prisma);
    await prisma.organization.update({
      where: { id: org.id },
      data: { inviteCode: code },
    });
    console.log(`Backfilled organization invite code for: ${org.name}`);
  }
}

const SEED_USERS = [
  {
    email: 'admin@sos-security.com',
    password: process.env.SEED_ADMIN_PASSWORD ?? 'admin123456',
    role: 'ADMIN' as const,
    phone: '+996555000001',
  },
  {
    email: 'operator@sos-security.com',
    password: process.env.SEED_OPERATOR_PASSWORD ?? 'operator123',
    role: 'OPERATOR' as const,
    phone: '+996555000002',
  },
  {
    email: 'user@example.com',
    password: process.env.SEED_USER_PASSWORD ?? '123456',
    role: 'USER' as const,
    phone: '+996555000003',
  },
];

async function main() {
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_PROD_SEED !== 'true') {
    console.error(
      'Refusing to run seed in NODE_ENV=production. ' +
        'Set ALLOW_PROD_SEED=true (and SEED_*_PASSWORD env vars) to override.',
    );
    process.exit(1);
  }

  let defaultOrg = await prisma.organization.findUnique({ where: { slug: 'default' } });
  if (!defaultOrg) {
    defaultOrg = await prisma.organization.create({
      data: { name: 'Default', type: 'PERSONAL', slug: 'default' },
    });
    console.log('Created Default organization');
  }

  for (const { email, password, role, phone } of SEED_USERS) {
    const existing = await prisma.user.findUnique({ where: { email } });
    if (!existing) {
      const user = await prisma.user.create({
        data: {
          email,
          password: await bcrypt.hash(password, 10),
          role,
          phone,
          orgMemberships: {
            create: {
              organizationId: defaultOrg.id,
              role: role === 'ADMIN' ? OrgMemberRole.OWNER : role === 'OPERATOR' ? OrgMemberRole.OPERATOR : OrgMemberRole.MEMBER,
            },
          },
        },
      });
      console.log(`Created ${role}: ${email}`);
    } else {
      const membership = await prisma.organizationMember.findUnique({
        where: { userId: existing.id },
      });
      if (!membership) {
        await prisma.organizationMember.create({
          data: {
            userId: existing.id,
            organizationId: defaultOrg.id,
            role: role === 'ADMIN' ? OrgMemberRole.OWNER : role === 'OPERATOR' ? OrgMemberRole.OPERATOR : OrgMemberRole.MEMBER,
          },
        });
        console.log(`Added ${email} to Default org`);
      } else if (membership.organizationId !== defaultOrg.id) {
        console.log(`Skip ${email}: already belongs to another organization`);
      } else {
        console.log(`Already exists, skipping: ${email}`);
      }
    }
  }

  await backfillBusinessOrgInviteCodes();
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
