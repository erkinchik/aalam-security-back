import * as Joi from 'joi';

export const validationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),

  PORT: Joi.number().default(3000),

  // Comma-separated list of origins allowed to call HTTP API and connect to /ws.
  // In production must be set explicitly; in dev defaults to local frontends.
  ALLOWED_ORIGINS: Joi.string().default(
    'http://localhost:5173,http://localhost:5174',
  ),

  // Database (DATABASE_URL is what the app actually uses; POSTGRES_* are read by
  // docker-compose to provision the postgres service, so they may be unset when
  // running outside Docker).
  DATABASE_URL: Joi.string().required(),
  POSTGRES_USER: Joi.string().optional(),
  POSTGRES_PASSWORD: Joi.string().optional(),
  POSTGRES_DB: Joi.string().optional(),

  REDIS_HOST: Joi.string().default('localhost'),
  REDIS_PORT: Joi.number().default(6379),
  REDIS_PASSWORD: Joi.string().optional().allow(''),

  JWT_ACCESS_SECRET: Joi.string().min(32).required(),
  // Совпадение секретов означало бы, что access-токен проходит проверку как
  // refresh: пятнадцатиминутный доступ превратился бы в семидневный.
  JWT_REFRESH_SECRET: Joi.string()
    .min(32)
    .required()
    .invalid(Joi.ref('JWT_ACCESS_SECRET'))
    .messages({
      'any.invalid': 'JWT_REFRESH_SECRET must differ from JWT_ACCESS_SECRET',
    }),
  JWT_ACCESS_EXPIRES: Joi.string().default('15m'),
  JWT_REFRESH_EXPIRES: Joi.string().default('7d'),

  // Нужен для ссылок в письмах. Без него восстановление пароля не включается.
  APP_URL: Joi.string().uri().optional(),

  // SMTP любого провайдера с бесплатным тарифом (Brevo, Resend, Яндекс 360).
  // Пусто — исходящая почта выключена, и сервер честно об этом отвечает.
  SMTP_HOST: Joi.string().optional().allow(''),
  SMTP_PORT: Joi.number().default(587),
  SMTP_USER: Joi.string().optional().allow(''),
  SMTP_PASSWORD: Joi.string().optional().allow(''),
  MAIL_FROM: Joi.string().optional().allow(''),

  // Allow `prisma db seed` to run when NODE_ENV=production.
  // Only set when you intentionally want to seed a prod database.
  ALLOW_PROD_SEED: Joi.string().valid('true', 'false').optional(),

  // PRD-5: pino log level. `info` is the prod default; `debug` for staging.
  LOG_LEVEL: Joi.string()
    .valid('trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent')
    .default('info'),

  // PRD-6: Sentry DSN. Empty/unset disables Sentry capture.
  SENTRY_DSN: Joi.string().uri().optional().allow(''),
  SENTRY_TRACES_SAMPLE_RATE: Joi.number().min(0).max(1).default(0.05),

  // PRD-11: /metrics is exposed unauthenticated by default. Scope by network
  // (Prometheus only reachable from internal subnet) or set METRICS_TOKEN
  // and pass it as ?token=... from your scraper.
  METRICS_TOKEN: Joi.string().optional().allow(''),

  // Telegram phone-verification bot. Both required so the bot's confirm
  // callback can be authenticated and the deep-link can be built server-side.
  TELEGRAM_BOT_SECRET: Joi.string().min(32).required(),
  TELEGRAM_BOT_USERNAME: Joi.string().required(),
});

function parseAllowedOrigins(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Parse durations like '15m', '7d', '365d', '3600s' into seconds.
 * Used to derive Redis TTL from the JWT lifetime so they always match —
 * a refresh token outliving its Redis entry would still be silently rejected.
 */
function parseDurationSeconds(raw: string, fallbackSeconds: number): number {
  const m = /^(\d+)([smhd])$/.exec(raw.trim());
  if (!m) return fallbackSeconds;
  const n = parseInt(m[1], 10);
  switch (m[2]) {
    case 's': return n;
    case 'm': return n * 60;
    case 'h': return n * 3600;
    case 'd': return n * 86400;
    default:  return fallbackSeconds;
  }
}

export default () => ({
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3000', 10),
  allowedOrigins: parseAllowedOrigins(process.env.ALLOWED_ORIGINS),
  logLevel: process.env.LOG_LEVEL || 'info',
  sentry: {
    dsn: process.env.SENTRY_DSN || undefined,
    tracesSampleRate: parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE || '0.05'),
  },
  metricsToken: process.env.METRICS_TOKEN || undefined,
  app: {
    // Дефолт указывал на несуществующий app.sos-security.com. Ссылки из писем
    // вели бы в никуда, поэтому адрес задаётся только через APP_URL.
    url: process.env.APP_URL,
  },
  database: {
    url: process.env.DATABASE_URL,
  },
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined,
  },
  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET,
    refreshSecret: process.env.JWT_REFRESH_SECRET,
    accessExpires: process.env.JWT_ACCESS_EXPIRES || '15m',
    refreshExpires: process.env.JWT_REFRESH_EXPIRES || '7d',
    // Redis stores refresh tokens with the same TTL as the JWT lifetime so
    // they expire together. Otherwise a still-valid JWT may be silently
    // rejected because Redis evicted its record first.
    refreshTtlSeconds: parseDurationSeconds(
      process.env.JWT_REFRESH_EXPIRES || '7d',
      7 * 86400,
    ),
  },
  mail: {
    host: process.env.SMTP_HOST || undefined,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    user: process.env.SMTP_USER || undefined,
    password: process.env.SMTP_PASSWORD || undefined,
    from: process.env.MAIL_FROM || undefined,
  },
  telegram: {
    botSecret: process.env.TELEGRAM_BOT_SECRET,
    botUsername: process.env.TELEGRAM_BOT_USERNAME,
  },
});
