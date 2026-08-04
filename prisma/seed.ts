import { PrismaClient, OrganizationType } from '@prisma/client';
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

  // Организацию 'Default' сид больше НЕ создаёт. Это была такая же синтетика,
  // как персональные 'My Account': запись существовала только чтобы кого-то
  // куда-то записать. Сотрудники получают организацию по инвайт-коду,
  // индивидуальные подписчики обходятся без неё вовсе.

  // Членство в организации сид тоже не выдаёт: права админа и оператора живут
  // в User.role, а не в OrganizationMember, поэтому вход в панель и доступ к
  // API работают без неё. Организация появляется только по инвайт-коду.
  for (const { email, password, role, phone } of SEED_USERS) {
    const existing = await prisma.user.findUnique({ where: { email } });
    if (!existing) {
      await prisma.user.create({
        data: {
          email,
          password: await bcrypt.hash(password, 10),
          role,
          phone,
        },
      });
      console.log(`Created ${role}: ${email}`);
    } else {
      console.log(`Already exists, skipping: ${email}`);
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
