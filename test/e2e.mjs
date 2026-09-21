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
    password: process.env.SEED_OPERATOR_PASSWORD ?? '123456',
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
  assert.equal(r.data.code, 'NOT_ON_SHIFT');
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
    assert.equal(loser.data.code, 'SESSION_ALREADY_CLAIMED');

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

/* ======================= 8b. Занятый оператор не получает новых вызовов ======================= */

test('занятому оператору пул пуст, а другому свободному — нет', async () => {
  const busy = await makeSubscribedUser('busy1');
  const taken = await api('POST', '/emergency/start', { token: busy.token, body: {} });
  const acc = await api('POST', `/dispatch/${taken.data.id}/accept`, { token: OPS.a.token });
  assert.equal(acc.status, 200);

  // Новый вызов приходит, пока A ведёт свой.
  const next = await makeSubscribedUser('busy2');
  const fresh = await api('POST', '/emergency/start', { token: next.token, body: {} });

  const poolA = await api('GET', '/dispatch/pool?limit=100', { token: OPS.a.token });
  assert.equal(poolA.status, 200);
  assert.equal(poolA.data.total, 0, 'у занятого оператора пул обязан быть пустым');

  // B на смене и свободен — вызов достаётся ему.
  await setShift(OPS.b, true);
  const poolB = await api('GET', '/dispatch/pool?limit=100', { token: OPS.b.token });
  assert.ok(
    poolB.data.data.some((x) => x.id === fresh.data.id),
    'свободный оператор обязан видеть вызов, который не показали занятому',
  );

  // Второй вызов занятому принять нельзя — иначе интерфейс прячет, а API отдаёт.
  const second = await api('POST', `/dispatch/${fresh.data.id}/accept`, { token: OPS.a.token });
  assert.equal(second.status, 409, `${second.status} ${msgOf(second.data)}`);
  assert.equal(second.data.code, 'OPERATOR_BUSY');

  // Закрыл свой — пул вернулся.
  const res = await api('POST', `/dispatch/${taken.data.id}/resolve`, {
    token: OPS.a.token,
    body: { resolution: 'проверка занятости' },
  });
  assert.equal(res.status, 200);

  const poolAfter = await api('GET', '/dispatch/pool?limit=100', { token: OPS.a.token });
  assert.ok(
    poolAfter.data.data.some((x) => x.id === fresh.data.id),
    'после закрытия своего вызова пул обязан вернуться',
  );

  await api('POST', `/dispatch/${fresh.data.id}/accept`, { token: OPS.b.token });
  await api('POST', `/dispatch/${fresh.data.id}/resolve`, {
    token: OPS.b.token,
    body: { resolution: 'cleanup' },
  });
  await setShift(OPS.b, false);
});

/* ======================= 8c. Мелочи ядра ======================= */

test('повторное заступление не сбрасывает время начала смены', async () => {
  await setShift(OPS.a, false);
  const first = await api('POST', '/dispatch/shift/start', { token: OPS.a.token });
  assert.equal(first.status, 200);
  const startedAt = first.data.shiftStartedAt;
  assert.ok(startedAt, 'время начала смены обязано быть выставлено');

  await sleep(1100);
  const again = await api('POST', '/dispatch/shift/start', { token: OPS.a.token });
  assert.equal(again.status, 200);
  assert.equal(
    again.data.shiftStartedAt,
    startedAt,
    'повторный запрос не должен обнулять отсчёт смены',
  );
});

test('координата пишется одним запросом и не проходит в закрытую сессию', async () => {
  const u = await makeSubscribedUser('loc1');
  const s = await api('POST', '/emergency/start', { token: u.token, body: {} });
  const id = s.data.id;

  const ok = await api('POST', `/emergency/${id}/location`, {
    token: u.token,
    body: { latitude: 42.87, longitude: 74.59, accuracy: 12 },
  });
  assertOk(ok, 'location');
  assert.equal(ok.data.latitude, 42.87);

  // Чужой пользователь.
  const other = await makeSubscribedUser('loc2');
  const foreign = await api('POST', `/emergency/${id}/location`, {
    token: other.token,
    body: { latitude: 1, longitude: 2, accuracy: 3 },
  });
  assert.equal(foreign.status, 403);
  assert.equal(foreign.data.code, 'NOT_YOUR_SESSION');

  await api('POST', `/emergency/${id}/close`, { token: u.token });

  const afterClose = await api('POST', `/emergency/${id}/location`, {
    token: u.token,
    body: { latitude: 42.88, longitude: 74.6, accuracy: 9 },
  });
  assert.equal(afterClose.status, 409, 'в закрытую сессию координаты не пишутся');
  assert.equal(afterClose.data.code, 'SESSION_ALREADY_CLOSED');

  const missing = await api('POST', '/emergency/00000000-0000-4000-8000-000000000000/location', {
    token: u.token,
    body: { latitude: 1, longitude: 2, accuracy: 3 },
  });
  assert.equal(missing.status, 404);
  assert.equal(missing.data.code, 'SESSION_NOT_FOUND');
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
  assert.equal(end.data.code, 'SHIFT_HAS_OPEN_SESSIONS');
  assert.equal(end.data.openSessions, 1);

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
  const r = await api('GET', '/admin/operators?limit=100', { token: T.admin });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.data.data) && r.data.data.length >= 3);
  assert.equal(typeof r.data.total, 'number', 'ответ обязан быть страничным');
  const op = r.data.data.find((o) => o.id === OPS.a.id);
  assert.ok(op, 'сидовый оператор должен быть в списке');
  assert.equal(typeof op.onShift, 'boolean');
  assert.ok('shiftStartedAt' in op);
  assert.equal(op.orgMemberships, undefined, 'привязка к организациям должна быть убрана');
  assert.equal(typeof op.activeSessionCount, 'number');
});

test('/admin/operators не принимает organizationId (операторы общие)', async () => {
  // Раньше параметр молча игнорировался. С появлением DTO у маршрута он
  // отвергается явно — так убранный фильтр не вернётся незамеченным.
  const filtered = await api(
    'GET',
    '/admin/operators?limit=100&organizationId=whatever',
    { token: T.admin },
  );
  assert.equal(filtered.status, 400, `${filtered.status} ${msgOf(filtered.data)}`);
});

test('списки операторов и организаций страничные', async () => {
  const firstPage = await api('GET', '/admin/operators?page=1&limit=1', {
    token: T.admin,
  });
  assert.equal(firstPage.status, 200);
  assert.equal(firstPage.data.limit, 1);
  assert.equal(firstPage.data.data.length, 1, 'страница обязана быть обрезана');
  assert.ok(firstPage.data.total > 1, 'total считает всех, а не страницу');

  const orgs = await api('GET', '/admin/organizations?page=1&limit=1', {
    token: T.admin,
  });
  assert.equal(orgs.status, 200);
  assert.ok(Array.isArray(orgs.data.data));
  assert.equal(typeof orgs.data.total, 'number');

  // Верхняя граница страницы защищена валидацией.
  const tooBig = await api('GET', '/admin/operators?limit=1000', { token: T.admin });
  assert.equal(tooBig.status, 400, 'limit сверх сотни не принимается');
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
  for (const name of [
    'emergency:new',
    'emergency:bootstrap',
    'emergency:assigned',
    'emergency:in_progress',
    'emergency:closed',
    'emergency:reassigned',
    'emergency:location_update',
    'emergency:pool_removed',
  ]) {
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

test('WS: новый SOS уходит админу и дежурному, но не оператору вне смены', { skip: wsSkip }, async (t) => {
  await setShift(OPS.a, true);
  await setShift(OPS.b, false);
  const admin = connect(T.admin);
  const onShift = connect(OPS.a.token);
  const offShift = connect(OPS.b.token);
  t.after(() => {
    for (const c of [admin, onShift, offShift]) c.socket.disconnect();
  });

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
  const offer = onShift.events.find((e) => e.name === 'emergency:new' && e.payload?.id === id);
  assert.ok('phone' in offer.payload.user, 'предложение обязано нести телефон заявителя');

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

  // Клиент заменяет вызов тем, что пришло. Урезанная карточка стирала у
  // оператора телефон, адрес и кнопку маршрута сразу после «Начать работу».
  const prog = await api('POST', `/dispatch/${id}/start-progress`, { token: OPS.a.token });
  assertOk(prog, 'start-progress');
  assert.ok(
    'phone' in prog.data.user && 'venue' in prog.data && Array.isArray(prog.data.locations),
    'ответ start-progress обязан быть полной карточкой',
  );
  const gotInProgress = await waitFor(() =>
    onShift.events.some((e) => e.name === 'emergency:in_progress' && e.payload?.id === id),
  );
  assert.ok(gotInProgress, 'назначенный оператор обязан получить emergency:in_progress');
  const inProgress = onShift.events.find(
    (e) => e.name === 'emergency:in_progress' && e.payload?.id === id,
  );
  assert.ok(
    'phone' in inProgress.payload.user && 'venue' in inProgress.payload,
    'событие in_progress обязано быть полной карточкой',
  );

  await api('POST', `/dispatch/${id}/resolve`, {
    token: OPS.a.token,
    body: { resolution: 'ws cleanup' },
  });
});

test('WS: занятый оператор не получает emergency:new, свободный получает', { skip: wsSkip }, async (t) => {
  await setShift(OPS.a, true);
  await setShift(OPS.b, true);
  const busy = connect(OPS.a.token);
  const free = connect(OPS.b.token);
  t.after(() => {
    for (const c of [busy, free]) c.socket.disconnect();
  });
  assert.ok(
    await waitFor(() => busy.socket.connected && free.socket.connected),
    'оба сокета должны подключиться',
  );

  // A занимает вызов и становится занятым.
  const u1 = await makeSubscribedUser('wsbusy1');
  const taken = await api('POST', '/emergency/start', { token: u1.token, body: {} });
  const acc = await api('POST', `/dispatch/${taken.data.id}/accept`, { token: OPS.a.token });
  assert.equal(acc.status, 200);

  const u2 = await makeSubscribedUser('wsbusy2');
  const fresh = await api('POST', '/emergency/start', { token: u2.token, body: {} });
  const id = fresh.data.id;

  const freeGot = await waitFor(() =>
    free.events.some((e) => e.name === 'emergency:new' && e.payload?.id === id),
  );
  assert.ok(freeGot, 'свободный дежурный обязан получить emergency:new');

  const busyGot = busy.events.some((e) => e.name === 'emergency:new' && e.payload?.id === id);
  assert.equal(busyGot, false, 'занятый оператор не должен получать emergency:new');

  await api('POST', `/dispatch/${taken.data.id}/resolve`, {
    token: OPS.a.token,
    body: { resolution: 'ws busy cleanup' },
  });
  await api('POST', `/dispatch/${id}/accept`, { token: OPS.b.token });
  await api('POST', `/dispatch/${id}/resolve`, {
    token: OPS.b.token,
    body: { resolution: 'ws busy cleanup' },
  });
  await setShift(OPS.b, false);
});

test('WS: чужой вызов не уносит персональные данные к другим операторам', { skip: wsSkip }, async (t) => {
  await setShift(OPS.a, true);
  await setShift(OPS.b, true);
  const a = connect(OPS.a.token);
  const b = connect(OPS.b.token);
  t.after(() => {
    for (const c of [a, b]) c.socket.disconnect();
  });
  assert.ok(await waitFor(() => a.socket.connected && b.socket.connected), 'сокеты должны подняться');

  const u = await makeSubscribedUser('leak1');
  const s = await api('POST', '/emergency/start', { token: u.token, body: {} });
  const id = s.data.id;
  assert.ok(await waitFor(() => b.events.some((e) => e.name === 'emergency:new' && e.payload?.id === id)));

  // A принимает вызов.
  const acc = await api('POST', `/dispatch/${id}/accept`, { token: OPS.a.token });
  assert.equal(acc.status, 200);

  // B узнаёт об этом, но только идентификатором.
  const gotRemoval = await waitFor(() =>
    b.events.some((e) => e.name === 'emergency:pool_removed' && e.payload?.id === id),
  );
  assert.ok(gotRemoval, 'свободный оператор обязан получить emergency:pool_removed');

  const removal = b.events.find((e) => e.name === 'emergency:pool_removed' && e.payload?.id === id);
  assert.deepEqual(Object.keys(removal.payload), ['id'], 'в payload не должно быть ничего, кроме id');

  const bGotAssigned = b.events.some((e) => e.name === 'emergency:assigned' && e.payload?.id === id);
  assert.equal(bGotAssigned, false, 'чужому оператору не должна уходить полная сессия');

  // А принявший — получает полную.
  const aAssigned = a.events.find((e) => e.name === 'emergency:assigned' && e.payload?.id === id);
  assert.ok(aAssigned, 'принявший оператор обязан получить emergency:assigned');
  assert.ok(aAssigned.payload.user, 'принявшему нужна полная сессия с заявителем');

  // Координаты по чужому вызову тоже не уходят.
  const loc = await api('POST', `/emergency/${id}/location`, {
    token: u.token,
    body: { latitude: 42.87, longitude: 74.59, accuracy: 10 },
  });
  assertOk(loc, 'location');
  assert.ok(
    await waitFor(() => a.events.some((e) => e.name === 'emergency:location_update')),
    'координаты обязаны дойти до назначенного оператора',
  );
  const bGotLocation = b.events.some(
    (e) => e.name === 'emergency:location_update' && e.payload?.session?.id === id,
  );
  assert.equal(bGotLocation, false, 'чужому оператору координаты не отправляются');

  await api('POST', `/dispatch/${id}/resolve`, {
    token: OPS.a.token,
    body: { resolution: 'leak cleanup' },
  });
  await setShift(OPS.b, false);
});

test('WS: снятие назначения возвращает вызов свободным дежурным', { skip: wsSkip }, async (t) => {
  await setShift(OPS.a, true);
  await setShift(OPS.b, true);
  const a = connect(OPS.a.token);
  const b = connect(OPS.b.token);
  t.after(() => {
    for (const c of [a, b]) c.socket.disconnect();
  });
  assert.ok(await waitFor(() => a.socket.connected && b.socket.connected));

  const u = await makeSubscribedUser('unassign1');
  const s = await api('POST', '/emergency/start', { token: u.token, body: {} });
  const id = s.data.id;
  const acc = await api('POST', `/dispatch/${id}/accept`, { token: OPS.a.token });
  assert.equal(acc.status, 200);

  b.events.length = 0;
  a.events.length = 0;

  const un = await api('POST', `/admin/emergencies/${id}/unassign`, { token: T.admin });
  assertOk(un, 'unassign');

  // Прежний исполнитель узнаёт, что вызов ушёл.
  assert.ok(
    await waitFor(() => a.events.some((e) => e.name === 'emergency:reassigned' && e.payload?.id === id)),
    'прежний исполнитель обязан узнать о снятии назначения',
  );
  // Свободные дежурные снова видят его как предложение.
  assert.ok(
    await waitFor(() => b.events.some((e) => e.name === 'emergency:new' && e.payload?.id === id)),
    'вернувшийся в пул вызов обязан прийти свободным дежурным',
  );

  await api('POST', `/admin/emergencies/${id}/close`, {
    token: T.admin,
    body: { resolution: 'unassign cleanup' },
  });
  await setShift(OPS.b, false);
});

test('админ не назначит вызов занятому оператору', async () => {
  const u1 = await makeSubscribedUser('busyassign1');
  const first = await api('POST', '/emergency/start', { token: u1.token, body: {} });
  const acc = await api('POST', `/dispatch/${first.data.id}/accept`, { token: OPS.a.token });
  assert.equal(acc.status, 200);

  const u2 = await makeSubscribedUser('busyassign2');
  const second = await api('POST', '/emergency/start', { token: u2.token, body: {} });
  const r = await api('POST', `/admin/emergencies/${second.data.id}/assign`, {
    token: T.admin,
    body: { operatorId: OPS.a.id },
  });
  assert.equal(r.status, 409, `${r.status} ${msgOf(r.data)}`);
  assert.equal(r.data.code, 'OPERATOR_BUSY');
  assert.equal(r.data.openSessions, 1);

  await api('POST', `/dispatch/${first.data.id}/resolve`, {
    token: OPS.a.token,
    body: { resolution: 'busy assign cleanup' },
  });
  await api('POST', `/admin/emergencies/${second.data.id}/close`, {
    token: T.admin,
    body: { resolution: 'busy assign cleanup' },
  });
});

test('карточка вызова доступна назначенному оператору и закрытая тоже', async () => {
  const u = await makeSubscribedUser('detail1');
  const s = await api('POST', '/emergency/start', { token: u.token, body: {} });
  const id = s.data.id;

  // Чужому оператору карточка не отдаётся.
  await setShift(OPS.b, true);
  const foreign = await api('GET', `/emergency/${id}`, { token: OPS.b.token });
  assert.equal(foreign.status, 403, `${foreign.status} ${msgOf(foreign.data)}`);
  assert.equal(foreign.data.code, 'NOT_ASSIGNED_TO_SESSION');
  await setShift(OPS.b, false);

  const acc = await api('POST', `/dispatch/${id}/accept`, { token: OPS.a.token });
  assert.equal(acc.status, 200);

  const mine = await api('GET', `/emergency/${id}`, { token: OPS.a.token });
  assert.equal(mine.status, 200);
  assert.equal(mine.data.id, id);
  assert.ok(mine.data.user, 'в карточке обязан быть заявитель');

  // Ради этого всё и делалось: закрытый вызов раньше не открывался вообще.
  const res = await api('POST', `/dispatch/${id}/resolve`, {
    token: OPS.a.token,
    body: { resolution: 'detail cleanup' },
  });
  assert.equal(res.status, 200);

  const closed = await api('GET', `/emergency/${id}`, { token: OPS.a.token });
  assert.equal(closed.status, 200, 'закрытый вызов обязан открываться');
  assert.equal(closed.data.status, 'CLOSED');

  const missing = await api('GET', '/emergency/00000000-0000-4000-8000-000000000000', {
    token: OPS.a.token,
  });
  assert.equal(missing.status, 404);
  assert.equal(missing.data.code, 'SESSION_NOT_FOUND');
});

test('GET /emergency/:id не перехватывает /emergency/history и /emergency/active', async () => {
  const hist = await api('GET', '/emergency/history', { token: T.user });
  assert.equal(hist.status, 200, 'history обязан остаться за USER');
  assert.ok(Array.isArray(hist.data.data));

  const active = await api('GET', '/emergency/active', { token: OPS.a.token });
  assert.equal(active.status, 200, 'active обязан остаться за оператором');
  assert.ok(Array.isArray(active.data.data));
});

/* ======================= 10b. Карточка оператора в админке ======================= */

test('админ правит оператора, меняет пароль и мягко удаляет', async () => {
  const op = await makeOperator('crud');

  // Карточка.
  const card = await api('GET', `/admin/operators/${op.id}`, { token: T.admin });
  assert.equal(card.status, 200);
  assert.equal(card.data.email, op.email);
  assert.equal(card.data.activeSessionCount, 0);

  // Правка данных.
  const upd = await api('PATCH', `/admin/operators/${op.id}`, {
    token: T.admin,
    body: { displayName: 'Иван Петров', phone: '+996555112233' },
  });
  assert.equal(upd.status, 200);
  assert.equal(upd.data.displayName, 'Иван Петров');
  assert.equal(upd.data.phone, '+996555112233');

  // Занятый email.
  const dup = await api('PATCH', `/admin/operators/${op.id}`, {
    token: T.admin,
    body: { email: SEED.operator.email },
  });
  assert.equal(dup.status, 409);
  assert.equal(dup.data.code, 'EMAIL_ALREADY_REGISTERED');

  // Кривой телефон не проходит валидацию.
  const badPhone = await api('PATCH', `/admin/operators/${op.id}`, {
    token: T.admin,
    body: { phone: '8905123' },
  });
  assert.equal(badPhone.status, 400);

  // Смена пароля: старый перестаёт работать, новый работает.
  const newPassword = 'Changed!2345';
  const pwd = await api('POST', `/admin/operators/${op.id}/password`, {
    token: T.admin,
    body: { password: newPassword },
  });
  assert.equal(pwd.status, 200);

  const oldLogin = await api('POST', '/auth/login', {
    body: { email: op.email, password: 'Operator!2345' },
  });
  assert.equal(oldLogin.status, 401, 'старый пароль обязан перестать работать');
  const freshToken = await login(op.email, newPassword);
  assert.ok(freshToken, 'новый пароль обязан работать');

  // Удаление с незакрытым вызовом запрещено.
  await api('POST', '/dispatch/shift/start', { token: freshToken });
  const u = await makeSubscribedUser('crudsos');
  const sos = await api('POST', '/emergency/start', { token: u.token, body: {} });
  const acc = await api('POST', `/dispatch/${sos.data.id}/accept`, { token: freshToken });
  assert.equal(acc.status, 200);

  const blocked = await api('DELETE', `/admin/operators/${op.id}`, { token: T.admin });
  assert.equal(blocked.status, 409, `${blocked.status} ${msgOf(blocked.data)}`);
  assert.equal(blocked.data.code, 'SHIFT_HAS_OPEN_SESSIONS');
  assert.equal(blocked.data.openSessions, 1);

  await api('POST', `/dispatch/${sos.data.id}/resolve`, {
    token: freshToken,
    body: { resolution: 'crud cleanup' },
  });

  // Мягкое удаление.
  const del = await api('DELETE', `/admin/operators/${op.id}`, { token: T.admin });
  assert.equal(del.status, 200);
  assert.equal(del.data.deleted, true);

  // Войти нельзя, в списке нет, карточки нет, назначить нельзя.
  const afterLogin = await api('POST', '/auth/login', {
    body: { email: op.email, password: newPassword },
  });
  assert.equal(afterLogin.status, 401, 'удалённый оператор не должен входить');

  const list = await api('GET', '/admin/operators?limit=100', { token: T.admin });
  assert.ok(
    !list.data.data.some((o) => o.id === op.id),
    'удалённого нет в списке',
  );

  const gone = await api('GET', `/admin/operators/${op.id}`, { token: T.admin });
  assert.equal(gone.status, 404);

  const assignDeleted = await api(
    `POST`,
    `/admin/emergencies/${sos.data.id}/assign`,
    { token: T.admin, body: { operatorId: op.id } },
  );
  assert.equal(assignDeleted.status, 400, 'на удалённого назначать нельзя');

  // Главное ради чего мягкое: история вызова уцелела.
  const history = await api('GET', `/admin/emergencies/${sos.data.id}`, { token: T.admin });
  assert.equal(history.status, 200);
  assert.equal(history.data.assignedOperatorId, op.id, 'исполнитель обязан остаться в истории');
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
  { skip: SLOW ? false : 'нужен E2E_SLOW=1 (тест длится ~4 минуты)' },
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

    // RECLAIM_ASSIGNMENT_THRESHOLD_MS = 120 c, cron тикает раз в 30 с.
    let backInPool = false;
    for (let i = 0; i < 32 && !backInPool; i++) {
      await sleep(5000);
      const pool = await api('GET', '/dispatch/pool?limit=100', { token: OPS.a.token });
      backInPool = pool.data.data.some((x) => x.id === id);
    }
    assert.ok(backInPool, 'вызов обязан вернуться в пул после потери heartbeat');

    const detail = await api('GET', `/admin/emergencies/${id}`, { token: T.admin });
    assert.equal(detail.data.status, 'NEW');
    assert.equal(detail.data.assignedOperatorId, null);

    // SHIFT_ALIVE_THRESHOLD_MS = 180 c — дальше снимается и смена.
    let shiftDropped = false;
    for (let i = 0; i < 24 && !shiftDropped; i++) {
      await sleep(5000);
      const ops = await api('GET', '/admin/operators?limit=100', { token: T.admin });
      shiftDropped =
        ops.data.data.find((o) => o.id === OPS.b.id)?.onShift === false;
    }
    assert.ok(shiftDropped, 'смена недоступного оператора обязана быть снята');

    pausedOps.delete(OPS.b.email);
    await api('POST', `/admin/emergencies/${id}/close`, {
      token: T.admin,
      body: { resolution: 'cron cleanup' },
    });
  },
);

test(
  'cron не отбирает вызов «В работе» и не снимает смену с оператора в пути',
  { skip: SLOW ? false : 'нужен E2E_SLOW=1 (тест длится ~3.5 минуты)' },
  async () => {
    await setShift(OPS.b, true);
    const u = await makeSubscribedUser('cronprog');
    const s = await api('POST', '/emergency/start', { token: u.token, body: {} });
    const id = s.data.id;
    assertOk(await api('POST', `/dispatch/${id}/accept`, { token: OPS.b.token }), 'accept');
    assertOk(
      await api('POST', `/dispatch/${id}/start-progress`, { token: OPS.b.token }),
      'start-progress',
    );

    // Оператор ушёл в навигатор: приложение в фоне, пульса нет.
    pausedOps.add(OPS.b.email);
    // Дольше порога смены (180 с) плюс тик cron (30 с).
    await sleep(215_000);

    const detail = await api('GET', `/admin/emergencies/${id}`, { token: T.admin });
    assert.equal(detail.data.status, 'IN_PROGRESS', 'вызов «В работе» не отбирается по тишине');
    assert.equal(detail.data.assignedOperatorId, OPS.b.id);
    const ops = await api('GET', '/admin/operators?limit=100', { token: T.admin });
    assert.equal(
      ops.data.data.find((o) => o.id === OPS.b.id)?.onShift,
      true,
      'смена оператора с вызовом в работе не снимается',
    );

    pausedOps.delete(OPS.b.email);
    await api('POST', `/dispatch/${id}/resolve`, {
      token: OPS.b.token,
      body: { resolution: 'cron in-progress cleanup' },
    });
    await setShift(OPS.b, false);
  },
);
