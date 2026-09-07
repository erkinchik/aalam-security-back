/**
 * Сквозные тесты бэкенда по живому API — без внешних зависимостей (node:test + fetch).
 *
 * Запуск:
 *   docker compose up -d && npx prisma db seed
 *   npm run test:e2e                      # быстрый набор
 *   E2E_SLOW=1 npm run test:e2e           # плюс cron-сценарий (~2.5 мин)
 *   E2E_BASE=http://localhost:3999 npm run test:e2e
 *
 * Учитывает боевые ограничения API: глобальный лимит 60 запросов/мин на IP и
 * 5 запросов к /auth/login на IP за 15 минут (поэтому логинов ровно четыре).
 * Смену подтверждает фоновый heartbeat, как это делает реальный клиент.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const BASE = process.env.E2E_BASE ?? 'http://localhost:3000';
const require = createRequire(import.meta.url);
let io = null;
let wsSkip = false;
for (const from of ['socket.io-client', '../../mobile/node_modules/socket.io-client']) {
  try {
    ({ io } = require(from));
    break;
  } catch {
    /* пробуем следующий путь */
  }
}
if (!io) {
  wsSkip = 'socket.io-client не найден (добавьте его в devDependencies)';
}

/* ---------- пейсер под глобальный throttler (60 req/min на IP) ---------- */
const WINDOW_MS = 60_000;
const SAFE_LIMIT = 52;
const stamps = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pace() {
  for (;;) {
    const now = Date.now();
    while (stamps.length && now - stamps[0] > WINDOW_MS) stamps.shift();
    if (stamps.length < SAFE_LIMIT) {
      stamps.push(now);
      return;
    }
    await sleep(WINDOW_MS - (now - stamps[0]) + 60);
  }
}

async function api(method, path, { token, body, headers = {}, skipPace } = {}) {
  if (!skipPace) await pace();
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

const msgOf = (d) =>
  Array.isArray(d?.message) ? d.message.join(', ') : (d?.message ?? d?.error ?? '');

/** Успех: 200 или 201 — конкретный код здесь не является предметом проверки. */
function assertOk(r, what) {
  assert.ok(
    r.status === 200 || r.status === 201,
    `${what}: ожидали 2xx, получили ${r.status} ${msgOf(r.data)}`,
  );
}

/* ---------- участники ---------- */
// Пароли сида берём из окружения — в .env они могут быть переопределены.
const SEED = {
  admin: {
    email: 'admin@sos-security.com',
    password: process.env.SEED_ADMIN_PASSWORD ?? 'admin123456',
  },
  operator: {
    email: 'operator@sos-security.com',
    password: process.env.SEED_OPERATOR_PASSWORD ?? 'operator123',
  },
  user: {
    email: 'user@example.com',
    password: process.env.SEED_USER_PASSWORD ?? '123456',
  },
};
const RUN = Date.now().toString(36);
/** Должно совпадать с LOGIN_LIMIT в src/common/guards/login-throttler.guard.ts. */
const LOGIN_LIMIT = 5;
const T = {}; // токены
const ID = {}; // id пользователей

async function login(email, password) {
  const r = await api('POST', '/auth/login', { body: { email, password } });
  assert.equal(r.status, 200, `login ${email}: ${r.status} ${msgOf(r.data)}`);
  return r.data.accessToken;
}

async function me(token) {
  const r = await api('GET', '/users/me', { token });
  assert.equal(r.status, 200, `/users/me: ${r.status}`);
  return r.data;
}

/** Свежий USER с активной подпиской — чтобы каждый SOS был независим. */
async function makeSubscribedUser(tag) {
  const email = `e2e.${RUN}.${tag}@example.com`;
  const reg = await api('POST', '/auth/register', {
    body: { email, password: 'Passw0rd!2345', phone: '+996555' + String(Math.floor(Math.random() * 900000) + 100000) },
  });
  assertOk(reg, `register ${email}`);
  const token = reg.data.accessToken;
  const sub = await api('POST', '/users/me/subscription/demo-activate', { token });
  assertOk(sub, 'demo-activate');
  return { email, token, refreshToken: reg.data.refreshToken };
}

async function makeOperator(tag) {
  const email = `e2e.op.${RUN}.${tag}@example.com`;
  const password = 'Operator!2345';
  const r = await api('POST', '/admin/users/create-operator', {
    token: T.admin,
    body: { email, password },
  });
  assertOk(r, 'create-operator');
  const token = await login(email, password);
  return { id: r.data.id, email, token };
}

const OPS = {};
let heartbeatTimer = null;

/** Операторы, которым намеренно перестали слать heartbeat (проверка cron). */
const pausedOps = new Set();

/** Heartbeat идёт вне очереди пейсера, но учитывается в его бюджете. */
async function heartbeat(op) {
  if (pausedOps.has(op.email)) return;
  stamps.push(Date.now());
  await api('POST', '/dispatch/heartbeat', { token: op.token, skipPace: true }).catch(() => {});
}

before(async () => {
  T.admin = await login(SEED.admin.email, SEED.admin.password);
  T.operator = await login(SEED.operator.email, SEED.operator.password);
  T.user = (await makeSubscribedUser('roles')).token;
  ID.operator = (await me(T.operator)).id;
  OPS.a = { id: ID.operator, email: SEED.operator.email, token: T.operator };
  OPS.b = await makeOperator('b');
  heartbeatTimer = setInterval(() => {
    void heartbeat(OPS.a);
    void heartbeat(OPS.b);
  }, 12_000);
});

/** Оператор B переводится между сменами: отдельный третий логин не помещается
 *  в лимит /auth/login (5 запросов на IP за 15 минут). */
async function setShift(op, onShift) {
  const r = await api('POST', `/dispatch/shift/${onShift ? 'start' : 'end'}`, { token: op.token });
  assert.equal(r.status, 200, `shift ${onShift} для ${op.email}: ${r.status} ${msgOf(r.data)}`);
  return r.data;
}

after(async () => {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  // Гасим смены, чтобы не оставлять окружение в «дежурном» состоянии.
  for (const op of [OPS.a, OPS.b]) {
    if (op?.token) await api('POST', '/dispatch/shift/end', { token: op.token });
  }
});

/* ======================= 1. Health / служебные ======================= */

test('health/live отвечает без БД', async () => {
  const r = await api('GET', '/health/live');
  assert.equal(r.status, 200);
  assert.equal(r.data.status, 'ok');
});

test('health/ready подтверждает postgres и redis', async () => {
  const r = await api('GET', '/health/ready');
  assert.equal(r.status, 200);
  assert.equal(r.data.info.postgres.status, 'up');
  assert.equal(r.data.info.redis.status, 'up');
});

test('/metrics отдаёт метрики prometheus', async () => {
  const r = await api('GET', '/metrics');
  assert.equal(r.status, 200);
  assert.match(String(r.data), /process_cpu_user_seconds_total/);
});

/* ======================= 2. Аутентификация ======================= */

test('логин с неверным паролем — 401', async () => {
  const r = await api('POST', '/auth/login', {
    body: { email: SEED.user.email, password: 'wrong-password' },
  });
  assert.equal(r.status, 401);
});

test('запрос без токена — 401', async () => {
  const r = await api('GET', '/users/me');
  assert.equal(r.status, 401);
});

test('refresh выдаёт новую пару и отзывает старый токен', async () => {
  const { refreshToken: oldRefresh } = await makeSubscribedUser('refresh');
  assert.ok(oldRefresh);

  const first = await api('POST', '/auth/refresh', { body: { refreshToken: oldRefresh } });
  assert.equal(first.status, 200, `refresh: ${first.status} ${msgOf(first.data)}`);
  assert.ok(first.data.accessToken && first.data.refreshToken);

  // Ротация: повторное использование того же refresh должно быть отвергнуто.
  const replay = await api('POST', '/auth/refresh', { body: { refreshToken: oldRefresh } });
  assert.equal(replay.status, 401, 'повторный refresh обязан быть отвергнут');
});

test('две ротации подряд выдают разные токены (jti)', async () => {
  const { refreshToken } = await makeSubscribedUser('jti');
  const a = await api('POST', '/auth/refresh', { body: { refreshToken } });
  assert.equal(a.status, 200);
  const b = await api('POST', '/auth/refresh', {
    body: { refreshToken: a.data.refreshToken },
  });
  assert.equal(b.status, 200);
  assert.notEqual(
    a.data.refreshToken,
    b.data.refreshToken,
    'без jti два обновления в одну секунду дают побайтово одинаковый JWT',
  );
});

test('лимит входа считается по паре IP+email, а не по одному IP', async () => {
  const victim = `e2e.${RUN}.throttle-a@example.com`;
  const bystander = `e2e.${RUN}.throttle-b@example.com`;

  // Незарегистрированные адреса: ответ 401, важен только счётчик попыток.
  let blockedAt = 0;
  for (let i = 1; i <= 7; i++) {
    const r = await api('POST', '/auth/login', {
      body: { email: victim, password: 'definitely-wrong' },
    });
    if (r.status === 429) {
      blockedAt = i;
      break;
    }
    assert.equal(r.status, 401, `попытка ${i}: ожидали 401, получили ${r.status}`);
  }
  assert.equal(blockedAt, LOGIN_LIMIT + 1, `блокировка должна наступить на попытке ${LOGIN_LIMIT + 1}`);

  // Другой адрес с того же IP не должен быть затронут — это и было багом.
  const other = await api('POST', '/auth/login', {
    body: { email: bystander, password: 'definitely-wrong' },
  });
  assert.equal(
    other.status,
    401,
    'другой email с того же IP не должен блокироваться вместе с первым',
  );
});

test('logout отзывает refresh-токен', async () => {
  const { token: accessToken, refreshToken } = await makeSubscribedUser('logout');
  const out = await api('POST', '/auth/logout', { token: accessToken, body: { refreshToken } });
  assert.equal(out.status, 200);
  const after = await api('POST', '/auth/refresh', { body: { refreshToken } });
  assert.equal(after.status, 401);
});

test('ValidationPipe отвергает лишнее поле в теле', async () => {
  const r = await api('POST', '/auth/register', {
    body: {
      email: `e2e.${RUN}.whitelist@example.com`,
      password: 'Passw0rd!2345',
      phone: '+996555777777',
      role: 'ADMIN',
    },
  });
  assert.equal(r.status, 400, 'forbidNonWhitelisted должен дать 400');
});

test('bot-callback без X-Bot-Secret — 401', async () => {
  const r = await api('POST', '/auth/telegram/verify/confirm', {
    body: { token: 'a'.repeat(64), phone: '+996555000009', telegramId: '1' },
  });
  assert.equal(r.status, 401);
});

/* ======================= 3. Разграничение ролей ======================= */

test('USER не имеет доступа к /dispatch и /admin', async () => {
  const a = await api('GET', '/dispatch/history', { token: T.user });
  assert.equal(a.status, 403);
  const b = await api('GET', '/admin/emergencies', { token: T.user });
  assert.equal(b.status, 403);
});

test('OPERATOR не имеет доступа к /admin', async () => {
  const r = await api('GET', '/admin/operators', { token: OPS.a.token });
  assert.equal(r.status, 403);
});

test('OPERATOR не может стартовать SOS', async () => {
  const r = await api('POST', '/emergency/start', { token: OPS.a.token, body: {} });
  assert.equal(r.status, 403);
});

/* ======================= 4. Смена оператора ======================= */

test('смена: изначально не на смене', async () => {
  const r = await api('GET', '/dispatch/shift', { token: OPS.a.token });
  assert.equal(r.status, 200);
  assert.equal(r.data.onShift, false);
  assert.equal(r.data.activeSessionCount, 0);
});

test('смена: заступление проставляет onShift и время', async () => {
  const r = await api('POST', '/dispatch/shift/start', { token: OPS.a.token });
  assert.equal(r.status, 200, `${r.status} ${msgOf(r.data)}`);
  assert.equal(r.data.onShift, true);
  assert.ok(r.data.shiftStartedAt, 'shiftStartedAt должен быть заполнен');

  const check = await api('GET', '/dispatch/shift', { token: OPS.a.token });
  assert.equal(check.data.onShift, true);
});

test('смена: повторное заступление идемпотентно', async () => {
  const r = await api('POST', '/dispatch/shift/start', { token: OPS.a.token });
  assert.equal(r.status, 200);
  assert.equal(r.data.onShift, true);
});

test('смена: сдача без вызовов проходит', async () => {
  const off = await api('POST', '/dispatch/shift/end', { token: OPS.a.token });
  assert.equal(off.status, 200);
  assert.equal(off.data.onShift, false);
  const on = await api('POST', '/dispatch/shift/start', { token: OPS.a.token });
  assert.equal(on.status, 200);
});

/* ======================= 5. Создание SOS ======================= */

test('SOS без подписки и без привязки к филиалу — 403', async () => {
  const email = `e2e.${RUN}.nosub@example.com`;
  const reg = await api('POST', '/auth/register', {
    body: { email, password: 'Passw0rd!2345', phone: '+996555123123' },
  });
  assertOk(reg, 'register');
  const r = await api('POST', '/emergency/start', { token: reg.data.accessToken, body: {} });
  assert.equal(r.status, 403, `ожидали 403, получили ${r.status} ${msgOf(r.data)}`);
});

test('SOS с подпиской создаётся в статусе NEW без оператора', async () => {
  const u = await makeSubscribedUser('sos1');
  const r = await api('POST', '/emergency/start', { token: u.token, body: {} });
  assertOk(r, 'emergency/start');
  assert.equal(r.data.status, 'NEW');
  assert.equal(r.data.assignedOperatorId, null);
  assert.equal(r.data.emergencyType, 'PERSONAL');
});

test('повторный старт возвращает ту же сессию (идемпотентность)', async () => {
  const u = await makeSubscribedUser('sos2');
  const a = await api('POST', '/emergency/start', { token: u.token, body: {} });
  const b = await api('POST', '/emergency/start', { token: u.token, body: {} });
  assert.equal(a.data.id, b.data.id, 'два старта подряд обязаны дать одну сессию');
});

test('координаты принимаются и попадают в историю', async () => {
  const u = await makeSubscribedUser('sos3');
  const s = await api('POST', '/emergency/start', { token: u.token, body: {} });
  const loc = await api('POST', `/emergency/${s.data.id}/location`, {
    token: u.token,
    body: { latitude: 42.8746, longitude: 74.5698, accuracy: 12.5 },
  });
  assertOk(loc, 'location');

  const hist = await api('GET', '/emergency/history', { token: u.token });
  assert.equal(hist.status, 200);
  assert.ok(hist.data.data.some((x) => x.id === s.data.id));
});

test('чужую сессию закрыть нельзя', async () => {
  const owner = await makeSubscribedUser('owner');
  const other = await makeSubscribedUser('other');
  const s = await api('POST', '/emergency/start', { token: owner.token, body: {} });
  const r = await api('POST', `/emergency/${s.data.id}/close`, { token: other.token });
  assert.equal(r.status, 403);
});

/* ======================= 6. Пул свободных вызовов ======================= */

test('пул виден оператору на смене и содержит новый вызов', async () => {
  const u = await makeSubscribedUser('pool1');
  const s = await api('POST', '/emergency/start', { token: u.token, body: {} });

  const pool = await api('GET', '/dispatch/pool?limit=100', { token: OPS.a.token });
  assert.equal(pool.status, 200);
  assert.ok(
    pool.data.data.some((x) => x.id === s.data.id),
    'вызов должен быть в пуле',
  );
  const found = pool.data.data.find((x) => x.id === s.data.id);
  assert.equal(found.status, 'NEW');
  assert.ok(found.user, 'в пуле должен приходить заявитель');
});

test('оператор вне смены получает пустой пул', async () => {
  const pool = await api('GET', '/dispatch/pool?limit=100', { token: OPS.b.token });
  assert.equal(pool.status, 200);
  assert.equal(pool.data.total, 0);
  assert.equal(pool.data.data.length, 0);
});

test('оператор вне смены не может принять вызов', async () => {
  const u = await makeSubscribedUser('offshift');
  const s = await api('POST', '/emergency/start', { token: u.token, body: {} });
  const r = await api('POST', `/dispatch/${s.data.id}/accept`, { token: OPS.b.token });
  assert.equal(r.status, 403, `${r.status} ${msgOf(r.data)}`);
  assert.match(msgOf(r.data), /смену/i);
});

/* ======================= 7. Гонка «кто первый принял» ======================= */

test('два оператора принимают одновременно: ровно один выигрывает (5 раундов)', async () => {
  const on = await api('POST', '/dispatch/shift/start', { token: OPS.b.token });
  assert.equal(on.status, 200);

  for (let round = 1; round <= 5; round++) {
    const u = await makeSubscribedUser(`race${round}`);
    const s = await api('POST', '/emergency/start', { token: u.token, body: {} });
    assertOk(s, `emergency/start раунд ${round}`);
    const sessionId = s.data.id;

    // Оба запроса уходят без пейсера, чтобы реально столкнуться.
    await pace();
    await pace();
    const [ra, rb] = await Promise.all([
      api('POST', `/dispatch/${sessionId}/accept`, { token: OPS.a.token, skipPace: true }),
      api('POST', `/dispatch/${sessionId}/accept`, { token: OPS.b.token, skipPace: true }),
    ]);

    const codes = [ra.status, rb.status].sort();
    assert.deepEqual(
      codes,
      [200, 409],
      `раунд ${round}: ожидали ровно один 200 и один 409, получили ${JSON.stringify(codes)}`,
    );

    const winner = ra.status === 200 ? ra : rb;
    const loser = ra.status === 200 ? rb : ra;
    assert.equal(winner.data.status, 'ASSIGNED');
    assert.ok(winner.data.assignedOperatorId, 'победитель должен быть назначен');
    assert.match(msgOf(loser.data), /принят другим/i);

    // Убираем за собой, иначе оператор не сможет сдать смену.
    const winnerToken =
      winner.data.assignedOperatorId === OPS.a.id ? OPS.a.token : OPS.b.token;
    const res = await api('POST', `/dispatch/${sessionId}/resolve`, {
      token: winnerToken,
      body: { resolution: `e2e round ${round}` },
    });
    assert.equal(res.status, 200, `resolve раунд ${round}: ${res.status} ${msgOf(res.data)}`);
  }
});

test('принять уже закрытый вызов нельзя', async () => {
  const u = await makeSubscribedUser('closed');
  const s = await api('POST', '/emergency/start', { token: u.token, body: {} });
  await api('POST', `/emergency/${s.data.id}/close`, { token: u.token });
  const r = await api('POST', `/dispatch/${s.data.id}/accept`, { token: OPS.a.token });
  assert.equal(r.status, 409, `${r.status} ${msgOf(r.data)}`);
});

test('принять несуществующий вызов — 404', async () => {
  const r = await api('POST', '/dispatch/00000000-0000-4000-8000-000000000000/accept', {
    token: OPS.a.token,
  });
  assert.equal(r.status, 404);
});

/* ======================= 8. Жизненный цикл после приёма ======================= */

test('полный цикл: принял → в работе → закрыл', async () => {
  const u = await makeSubscribedUser('cycle');
  const s = await api('POST', '/emergency/start', { token: u.token, body: {} });
  const id = s.data.id;

  const acc = await api('POST', `/dispatch/${id}/accept`, { token: OPS.a.token });
  assert.equal(acc.status, 200);
  assert.equal(acc.data.status, 'ASSIGNED');

  // Вызов ушёл из пула для всех.
  const pool = await api('GET', '/dispatch/pool?limit=100', { token: OPS.b.token });
  assert.ok(!pool.data.data.some((x) => x.id === id), 'принятый вызов обязан исчезнуть из пула');

  // Появился в «моих».
  const active = await api('GET', '/emergency/active', { token: OPS.a.token });
  assert.ok(active.data.data.some((x) => x.id === id), 'вызов должен быть в /emergency/active');

  // Чужой оператор не может двигать статус.
  const foreign = await api('POST', `/dispatch/${id}/start-progress`, { token: OPS.b.token });
  assert.equal(foreign.status, 403, `${foreign.status} ${msgOf(foreign.data)}`);

  const prog = await api('POST', `/dispatch/${id}/start-progress`, { token: OPS.a.token });
  assert.equal(prog.status, 200);
  assert.equal(prog.data.status, 'IN_PROGRESS');

  const res = await api('POST', `/dispatch/${id}/resolve`, {
    token: OPS.a.token,
    body: { resolution: 'ложный вызов' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.status, 'CLOSED');
  assert.equal(res.data.resolution, 'ложный вызов');

  const again = await api('POST', `/dispatch/${id}/resolve`, {
    token: OPS.a.token,
    body: { resolution: 'повтор' },
  });
  assert.equal(again.status, 409, 'повторное закрытие обязано дать 409');
});

test('resolve без текста резолюции — 400', async () => {
  const u = await makeSubscribedUser('nores');
  const s = await api('POST', '/emergency/start', { token: u.token, body: {} });
  await api('POST', `/dispatch/${s.data.id}/accept`, { token: OPS.a.token });
  const r = await api('POST', `/dispatch/${s.data.id}/resolve`, {
    token: OPS.a.token,
    body: { resolution: '' },
  });
  assert.equal(r.status, 400);
  await api('POST', `/dispatch/${s.data.id}/resolve`, {
    token: OPS.a.token,
    body: { resolution: 'cleanup' },
  });
});

/* ======================= 9. Сдача смены с открытыми вызовами ======================= */

test('сдать смену с незакрытым вызовом нельзя (409 с числом)', async () => {
  const u = await makeSubscribedUser('shiftguard');
  const s = await api('POST', '/emergency/start', { token: u.token, body: {} });
  const acc = await api('POST', `/dispatch/${s.data.id}/accept`, { token: OPS.a.token });
  assert.equal(acc.status, 200);

  const shift = await api('GET', '/dispatch/shift', { token: OPS.a.token });
  assert.equal(shift.data.activeSessionCount, 1);

  const end = await api('POST', '/dispatch/shift/end', { token: OPS.a.token });
  assert.equal(end.status, 409, `${end.status} ${msgOf(end.data)}`);
  assert.match(msgOf(end.data), /1/);

  // Закрыли — теперь смена сдаётся.
  await api('POST', `/dispatch/${s.data.id}/resolve`, {
    token: OPS.a.token,
    body: { resolution: 'закрыт для теста смены' },
  });
  const end2 = await api('POST', '/dispatch/shift/end', { token: OPS.a.token });
  assert.equal(end2.status, 200);
  await api('POST', '/dispatch/shift/start', { token: OPS.a.token });
});

/* ======================= 10. Админ ======================= */

test('/admin/operators отдаёт смену и не отдаёт организации', async () => {
  const r = await api('GET', '/admin/operators', { token: T.admin });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.data) && r.data.length >= 3);
  const op = r.data.find((o) => o.id === OPS.a.id);
  assert.ok(op, 'сидовый оператор должен быть в списке');
  assert.equal(typeof op.onShift, 'boolean');
  assert.ok('shiftStartedAt' in op);
  assert.equal(op.orgMemberships, undefined, 'привязка к организациям должна быть убрана');
  assert.equal(typeof op.activeSessionCount, 'number');
});

test('/admin/operators игнорирует organizationId (операторы общие)', async () => {
  const all = await api('GET', '/admin/operators', { token: T.admin });
  const filtered = await api('GET', '/admin/operators?organizationId=whatever', {
    token: T.admin,
  });
  assert.equal(filtered.status, 200);
  assert.equal(filtered.data.length, all.data.length);
});

test('админ ставит и снимает оператора со смены', async () => {
  const on = await api('POST', `/admin/operators/${OPS.b.id}/shift`, {
    token: T.admin,
    body: { onShift: true },
  });
  assert.equal(on.status, 200, `${on.status} ${msgOf(on.data)}`);
  assert.equal(on.data.onShift, true);

  const check = await api('GET', '/dispatch/shift', { token: OPS.b.token });
  assert.equal(check.data.onShift, true);

  const off = await api('POST', `/admin/operators/${OPS.b.id}/shift`, {
    token: T.admin,
    body: { onShift: false },
  });
  assert.equal(off.status, 200);
  assert.equal(off.data.onShift, false);
});

test('админ не снимет со смены оператора с открытым вызовом', async () => {
  const u = await makeSubscribedUser('adminguard');
  const s = await api('POST', '/emergency/start', { token: u.token, body: {} });
  await api('POST', `/dispatch/${s.data.id}/accept`, { token: OPS.a.token });

  const off = await api('POST', `/admin/operators/${OPS.a.id}/shift`, {
    token: T.admin,
    body: { onShift: false },
  });
  assert.equal(off.status, 409, `${off.status} ${msgOf(off.data)}`);

  await api('POST', `/dispatch/${s.data.id}/resolve`, {
    token: OPS.a.token,
    body: { resolution: 'cleanup admin guard' },
  });
});

test('shift-эндпоинт валидирует тело', async () => {
  const r = await api('POST', `/admin/operators/${OPS.b.id}/shift`, {
    token: T.admin,
    body: { onShift: 'yes' },
  });
  assert.equal(r.status, 400);
});

test('админ назначает, переназначает и снимает назначение', async () => {
  const u = await makeSubscribedUser('adminassign');
  const s = await api('POST', '/emergency/start', { token: u.token, body: {} });
  const id = s.data.id;

  const asg = await api('POST', `/admin/emergencies/${id}/assign`, {
    token: T.admin,
    body: { operatorId: OPS.a.id },
  });
  assertOk(asg, 'assign');
  assert.equal(asg.data.status, 'ASSIGNED');
  assert.equal(asg.data.assignedOperatorId, OPS.a.id);

  const re = await api('POST', `/admin/emergencies/${id}/reassign`, {
    token: T.admin,
    body: { operatorId: OPS.b.id },
  });
  assertOk(re, 'reassign');
  assert.equal(re.data.assignedOperatorId, OPS.b.id);

  const un = await api('POST', `/admin/emergencies/${id}/unassign`, { token: T.admin });
  assertOk(un, 'unassign');
  assert.equal(un.data.status, 'NEW');
  assert.equal(un.data.assignedOperatorId, null);

  // Вернулся в пул — снова доступен к приёму.
  const pool = await api('GET', '/dispatch/pool?limit=100', { token: OPS.a.token });
  assert.ok(pool.data.data.some((x) => x.id === id), 'снятый вызов обязан вернуться в пул');

  const close = await api('POST', `/admin/emergencies/${id}/close`, {
    token: T.admin,
    body: { resolution: 'закрыт админом' },
  });
  assertOk(close, 'close');
  assert.equal(close.data.status, 'CLOSED');
});

test('админ не назначит вызов на не-оператора', async () => {
  const u = await makeSubscribedUser('badassign');
  const s = await api('POST', '/emergency/start', { token: u.token, body: {} });
  const meUser = await me(u.token);
  const r = await api('POST', `/admin/emergencies/${s.data.id}/assign`, {
    token: T.admin,
    body: { operatorId: meUser.id },
  });
  assert.equal(r.status, 400, `${r.status} ${msgOf(r.data)}`);
});

test('фильтры /admin/emergencies работают', async () => {
  const unassigned = await api('GET', '/admin/emergencies?status=NEW&assigned=false&limit=100', {
    token: T.admin,
  });
  assert.equal(unassigned.status, 200);
  assert.ok(unassigned.data.data.every((s) => s.status === 'NEW' && s.assignedOperatorId === null));
  assert.equal(typeof unassigned.data.total, 'number');
});

/* ======================= 11. WebSocket ======================= */

function connect(token) {
  const socket = io(`${BASE}/ws`, {
    auth: { token },
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
  });
  const events = [];
  for (const name of ['emergency:new', 'emergency:bootstrap', 'emergency:assigned']) {
    socket.on(name, (payload) => events.push({ name, payload }));
  }
  return { socket, events };
}

const waitFor = (predicate, ms = 4000) =>
  new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      if (predicate()) return resolve(true);
      if (Date.now() - started > ms) return resolve(false);
      setTimeout(tick, 50);
    };
    tick();
  });

test('WS: новый SOS уходит админу и дежурному, но не оператору вне смены', { skip: wsSkip }, async () => {
  await setShift(OPS.a, true);
  await setShift(OPS.b, false);
  const admin = connect(T.admin);
  const onShift = connect(OPS.a.token);
  const offShift = connect(OPS.b.token);

  const connected = await waitFor(
    () => admin.socket.connected && onShift.socket.connected && offShift.socket.connected,
  );
  assert.ok(connected, 'все три сокета должны подключиться');

  // Оператор на смене получает снимок пула при подключении.
  const gotBootstrap = await waitFor(() =>
    onShift.events.some((e) => e.name === 'emergency:bootstrap'),
  );
  assert.ok(gotBootstrap, 'оператор обязан получить emergency:bootstrap');

  const u = await makeSubscribedUser('ws1');
  const s = await api('POST', '/emergency/start', { token: u.token, body: {} });
  const id = s.data.id;

  const adminGot = await waitFor(() =>
    admin.events.some((e) => e.name === 'emergency:new' && e.payload?.id === id),
  );
  const onShiftGot = await waitFor(() =>
    onShift.events.some((e) => e.name === 'emergency:new' && e.payload?.id === id),
  );
  assert.ok(adminGot, 'админ обязан получить emergency:new');
  assert.ok(onShiftGot, 'дежурный оператор обязан получить emergency:new');

  const offShiftGot = offShift.events.some(
    (e) => e.name === 'emergency:new' && e.payload?.id === id,
  );
  assert.equal(offShiftGot, false, 'оператор вне смены не должен получать emergency:new');

  // Приём вызова рассылается как emergency:assigned.
  await api('POST', `/dispatch/${id}/accept`, { token: OPS.a.token });
  const assignedBroadcast = await waitFor(() =>
    onShift.events.some((e) => e.name === 'emergency:assigned' && e.payload?.id === id),
  );
  assert.ok(assignedBroadcast, 'после приёма обязан прийти emergency:assigned');

  await api('POST', `/dispatch/${id}/resolve`, {
    token: OPS.a.token,
    body: { resolution: 'ws cleanup' },
  });

  for (const c of [admin, onShift, offShift]) c.socket.disconnect();
});

test('WS: подключение без токена отвергается', { skip: wsSkip }, async () => {
  const socket = io(`${BASE}/ws`, { transports: ['websocket'], forceNew: true, reconnection: false });
  const closed = await new Promise((resolve) => {
    socket.on('disconnect', () => resolve(true));
    socket.on('connect_error', () => resolve(true));
    setTimeout(() => resolve(false), 4000);
  });
  socket.disconnect();
  assert.ok(closed, 'сокет без токена должен быть отключён');
});


/* ======================= 12. Cron: потеря связи с оператором ======================= */

const SLOW = process.env.E2E_SLOW === '1';

test(
  'cron возвращает вызов в пул и снимает смену с недоступного оператора',
  { skip: SLOW ? false : 'нужен E2E_SLOW=1 (тест длится ~2.5 минуты)' },
  async () => {
    await setShift(OPS.b, true);
    const u = await makeSubscribedUser('cron');
    const s = await api('POST', '/emergency/start', { token: u.token, body: {} });
    const id = s.data.id;

    const acc = await api('POST', `/dispatch/${id}/accept`, { token: OPS.b.token });
    assertOk(acc, 'accept');
    assert.equal(acc.data.assignedOperatorId, OPS.b.id);

    // Оператор «пропал»: телефон сел, приложение убито.
    pausedOps.add(OPS.b.email);

    // ONLINE_THRESHOLD_MS = 35 c, cron тикает раз в 30 с.
    let backInPool = false;
    for (let i = 0; i < 15 && !backInPool; i++) {
      await sleep(5000);
      const pool = await api('GET', '/dispatch/pool?limit=100', { token: OPS.a.token });
      backInPool = pool.data.data.some((x) => x.id === id);
    }
    assert.ok(backInPool, 'вызов обязан вернуться в пул после потери heartbeat');

    const detail = await api('GET', `/admin/emergencies/${id}`, { token: T.admin });
    assert.equal(detail.data.status, 'NEW');
    assert.equal(detail.data.assignedOperatorId, null);

    // SHIFT_ALIVE_THRESHOLD_MS = 120 c — дальше снимается и смена.
    let shiftDropped = false;
    for (let i = 0; i < 22 && !shiftDropped; i++) {
      await sleep(5000);
      const ops = await api('GET', '/admin/operators', { token: T.admin });
      shiftDropped = ops.data.find((o) => o.id === OPS.b.id)?.onShift === false;
    }
    assert.ok(shiftDropped, 'смена недоступного оператора обязана быть снята');

    pausedOps.delete(OPS.b.email);
    await api('POST', `/admin/emergencies/${id}/close`, {
      token: T.admin,
      body: { resolution: 'cron cleanup' },
    });
  },
);
