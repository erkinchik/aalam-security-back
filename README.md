# SOS Security — backend

NestJS 10 + Prisma 5 + PostgreSQL 15 + Redis 7 + Socket.IO 4.

## Запуск

```bash
docker compose up -d          # postgres, redis, api
npx prisma migrate deploy     # при работе снаружи контейнера — DATABASE_URL с localhost
```

Swagger доступен на `/api/docs`, когда `NODE_ENV` не `production`.

## Тесты

```bash
npm run test:e2e
```

Скрипт читает `.env` сам (`node --env-file`). Если задаёте переменные руками,
не ставьте `SEED_OPERATOR_PASSWORD=` пустым: в сиде стоит `?? 'operator123'`, а
пустая строка не nullish и перебьёт значение по умолчанию.

Медленный крон-тест выключен по умолчанию, включается `E2E_SLOW=1`.

## Почта

Восстановление пароля работает, только когда заданы SMTP-переменные и `APP_URL`.
Провайдер не зашит — подойдёт любой с бесплатным тарифом:

| Провайдер | Бесплатно | Хост / порт |
|---|---|---|
| Brevo | 300 писем в сутки, карта не нужна | `smtp-relay.brevo.com` : 587 |
| Resend | 3000 в месяц, нужна верификация домена | `smtp.resend.com` : 587 |
| Яндекс 360 | в рамках тарифа домена | `smtp.yandex.ru` : 465 |

```env
SMTP_HOST=smtp-relay.brevo.com
SMTP_PORT=587
SMTP_USER=<логин SMTP>
SMTP_PASSWORD=<ключ SMTP>
MAIL_FROM="SOS Security <no-reply@sossecurty.com>"
APP_URL=https://sossecurty.com
```

Пока переменные пусты, `POST /auth/forgot-password` отвечает
`503 PASSWORD_RESET_UNAVAILABLE`, а клиенты показывают «обратитесь к
администратору» — вместо того чтобы обещать письмо, которое некому отправить.
Сброс пароля оператора админом работает независимо от почты.

## Почему ровно один экземпляр

Бэкенд рассчитан на **один процесс**. Три места, которые сломаются при
масштабировании:

1. **Socket.IO без redis-адаптера.** Комнаты (`admin_room`, `on_shift_operators`,
   `operator_<id>`), `fetchSockets()` и `socketsJoin/Leave` живут в памяти узла.
   Вторая реплика не получит рассылку нового вызова, а `CronService`, считающий
   присутствие через `fetchSockets()`, решит, что операторы соседнего узла
   мертвы, и снимет их со смены.
2. **Throttler в памяти.** `ThrottlerModule.forRoot` без Redis-хранилища —
   лимиты умножаются на число реплик.
3. **Cron.** Задачи защищены распределённым локом в Redis и переживут вторую
   реплику, но сами по себе смысла в нескольких копиях не имеют.

Перед горизонтальным масштабированием: `@socket.io/redis-adapter` и
`ThrottlerStorageRedisService`. Подробности — в `../TASKS.md`, пункты B2 и 15.

## Маршрутизация событий

Полная сессия (имя, телефон, адрес, координаты заявителя) уходит только тем, кто
с вызовом работает:

| Событие | Кому |
|---|---|
| `emergency:new` | `admin_room` + свободные дежурные |
| `emergency:pool_removed` | `on_shift_operators`, только `{ id }` |
| `emergency:assigned` / `in_progress` / `closed` | `admin_room` + назначенный оператор + заявитель |
| `emergency:reassigned` | то же + прежний исполнитель |
| `emergency:location_update` | `admin_room` + назначенный оператор + заявитель |

Комната `operators` для рассылок больше не используется.

## Коды ошибок

Сервер отдаёт машинный `code` (см. `src/common/errors/error-codes.ts`), текст
подбирает клиент из своей локали. Поле `message` остаётся английским — оно для
логов и Sentry. Клиент, не знающий кода, показывает `message`, поэтому коды
можно вводить постепенно.
