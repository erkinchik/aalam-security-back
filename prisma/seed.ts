import { PrismaClient, OrgMemberRole } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const SEED_USERS = [
  { email: 'admin@alarm-sos.com',    password: 'admin123456', role: 'ADMIN' as const },
  { email: 'operator@alarm-sos.com', password: 'operator123', role: 'OPERATOR' as const },
  { email: 'user@example.com',       password: '123456',      role: 'USER' as const },
];

async function main() {
  let defaultOrg = await prisma.organization.findUnique({ where: { slug: 'default' } });
  if (!defaultOrg) {
    defaultOrg = await prisma.organization.create({
      data: { name: 'Default', type: 'PERSONAL', slug: 'default' },
    });
    console.log('Created Default organization');
  }

  for (const { email, password, role } of SEED_USERS) {
    const existing = await prisma.user.findUnique({ where: { email } });
    if (!existing) {
      const user = await prisma.user.create({
        data: {
          email,
          password: await bcrypt.hash(password, 10),
          role,
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
        where: { userId_organizationId: { userId: existing.id, organizationId: defaultOrg.id } },
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
      } else {
        console.log(`Already exists, skipping: ${email}`);
      }
    }
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
