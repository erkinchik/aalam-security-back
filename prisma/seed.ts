import { PrismaClient, OrgMemberRole } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { generateUniqueInviteCodeAcrossTables } from './lib/invite-code';

const prisma = new PrismaClient();

async function backfillOrgInviteCodes() {
  // Тип организации убран — код приглашения нужен каждой.
  const missing = await prisma.organization.findMany({
    where: { inviteCode: null },
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
    note: 'админ-панель',
  },
  {
    email: 'operator@sos-security.com',
    password: process.env.SEED_OPERATOR_PASSWORD ?? '123456',
    role: 'OPERATOR' as const,
    phone: '+996555000002',
    note: 'оператор',
  },
  {
    email: 'user@example.com',
    password: process.env.SEED_USER_PASSWORD ?? '123456',
    role: 'USER' as const,
    phone: '+996555000003',
    note: 'без подписки и организации — видит баннер «Отправка SOS недоступна»',
  },
  {
    email: 'subscriber@example.com',
    password: process.env.SEED_SUBSCRIBER_PASSWORD ?? '123456',
    role: 'USER' as const,
    phone: '+996555000004',
    subscription: true,
    note: 'индивидуальная подписка — личный SOS без организации',
  },
  {
    email: 'owner@example.com',
    password: process.env.SEED_OWNER_PASSWORD ?? '123456',
    role: 'USER' as const,
    phone: '+996555000005',
    note: 'владелец ЧОП «Беркут» — выбор объекта при вызове, коды приглашений',
  },
  {
    email: 'employee@example.com',
    password: process.env.SEED_EMPLOYEE_PASSWORD ?? '123456',
    role: 'USER' as const,
    phone: '+996555000006',
    note: 'сотрудник, привязан к «Офис на Чуй» — SOS с адресом объекта',
  },
];

/**
 * Демо-организация для ручной проверки бизнес-сценария.
 *
 * Коды заданы фиксированными намеренно: сгенерированные случайно приходилось бы
 * каждый раз выковыривать из базы, а так их можно просто ввести в приложении.
 * Символы взяты из того же читаемого алфавита, что и у генератора: без 0, O, I, 1.
 */
const DEMO_ORG = {
  name: 'ЧОП «Беркут»',
  slug: 'berkut',
  inviteCode: 'BERKUT',
  // Координаты обязательны: при вызове с объекта приложение шлёт именно их и
  // не трогает GPS телефона. Без них демо-сценарий сотрудника не проверить.
  venues: [
    { name: 'Офис на Чуй', address: 'пр. Чуй, 100', inviteCode: 'CHUY22', latitude: 42.8759, longitude: 74.6012 },
    { name: 'Склад на Манаса', address: 'ул. Манаса, 40', inviteCode: 'MANAS3', latitude: 42.8701, longitude: 74.5893 },
  ],
};

/** Кого сид реально создал в этом запуске — только их пароли он и знает. */
const createdNow = new Set<string>();

async function seedUsers() {
  for (const u of SEED_USERS) {
    const existing = await prisma.user.findUnique({ where: { email: u.email } });
    if (existing) {
      console.log(`Уже есть, пропускаю: ${u.email}`);
      continue;
    }
    await prisma.user.create({
      data: {
        email: u.email,
        password: await bcrypt.hash(u.password, 10),
        role: u.role,
        phone: u.phone,
        ...('subscription' in u && u.subscription
          ? {
              individualSubscriptionActive: true,
              // Месяц вперёд, чтобы подписка выглядела как настоящая.
              subscriptionExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
            }
          : {}),
      },
    });
    createdNow.add(u.email);
    console.log(`Создан ${u.role}: ${u.email}`);
  }
}

async function seedDemoOrganization() {
  let org = await prisma.organization.findUnique({ where: { slug: DEMO_ORG.slug } });
  if (!org) {
    org = await prisma.organization.create({
      data: {
        name: DEMO_ORG.name,
        slug: DEMO_ORG.slug,
        inviteCode: DEMO_ORG.inviteCode,
      },
    });
    console.log(`Создана организация: ${org.name} (код ${DEMO_ORG.inviteCode})`);
  }

  for (const v of DEMO_ORG.venues) {
    const exists = await prisma.venue.findUnique({ where: { inviteCode: v.inviteCode } });
    if (exists) continue;
    await prisma.venue.create({
      data: {
        organizationId: org.id,
        name: v.name,
        address: v.address,
        latitude: v.latitude,
        longitude: v.longitude,
        inviteCode: v.inviteCode,
      },
    });
    console.log(`Создан объект: ${v.name} (код ${v.inviteCode})`);
  }

  return org;
}

/**
 * Членство выдаётся ТОЛЬКО демо-владельцу и демо-сотруднику.
 * Админ, оператор и обычные пользователи остаются без организации: их права
 * живут в User.role, а лишняя запись только замусорила бы таблицу.
 */
async function seedDemoMemberships(organizationId: string) {
  const venue = await prisma.venue.findUnique({
    where: { inviteCode: DEMO_ORG.venues[0].inviteCode },
  });

  const links = [
    { email: 'owner@example.com', role: OrgMemberRole.OWNER, venueId: null },
    { email: 'employee@example.com', role: OrgMemberRole.MEMBER, venueId: venue?.id ?? null },
  ];

  for (const link of links) {
    const user = await prisma.user.findUnique({ where: { email: link.email } });
    if (!user) continue;
    // @@unique([userId]) — членство одно на пользователя.
    const membership = await prisma.organizationMember.findUnique({
      where: { userId: user.id },
    });
    if (membership) {
      console.log(`У ${link.email} уже есть организация, пропускаю`);
      continue;
    }
    await prisma.organizationMember.create({
      data: {
        userId: user.id,
        organizationId,
        role: link.role,
        venueId: link.venueId,
      },
    });
    console.log(`${link.email} добавлен как ${link.role}`);
  }
}

function printSummary() {
  const line = (email: string, pass: string, note: string) =>
    console.log(`  ${email.padEnd(28)} ${pass.padEnd(16)} ${note}`);

  console.log('\n──────────── УЧЁТНЫЕ ЗАПИСИ ────────────');
  // Для уже существовавших пароль не печатаем: в базе давно может лежать
  // другой, и показать здесь дефолт из кода — значит соврать.
  for (const u of SEED_USERS) {
    line(u.email, createdNow.has(u.email) ? u.password : '(не менялся)', u.note);
  }

  console.log('\n──────────── КОДЫ ПРИГЛАШЕНИЙ ────────────');
  console.log(`  ${DEMO_ORG.inviteCode}  — вся организация «${DEMO_ORG.name}», без привязки к объекту`);
  for (const v of DEMO_ORG.venues) {
    console.log(`  ${v.inviteCode}  — ${v.name}`);
  }
  console.log('\n  Ввести код: приложение → «Организация» → «Подключиться по коду».');
  console.log('  Новые объекты и коды создаются в админ-панели: Организации → карточка организации.\n');
}

async function main() {
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_PROD_SEED !== 'true') {
    console.error(
      'Refusing to run seed in NODE_ENV=production. ' +
        'Set ALLOW_PROD_SEED=true (and SEED_*_PASSWORD env vars) to override.',
    );
    process.exit(1);
  }

  await seedUsers();
  const org = await seedDemoOrganization();
  await seedDemoMemberships(org.id);
  await backfillOrgInviteCodes();
  printSummary();
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
