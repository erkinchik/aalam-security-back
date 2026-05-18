import * as Sentry from '@sentry/node';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger as PinoLogger } from 'nestjs-pino';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';

// PRD-6: initialise Sentry as early as possible, before the Nest app is built,
// so any error during bootstrap is still reported. No-op if SENTRY_DSN is empty.
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'development',
    tracesSampleRate: parseFloat(
      process.env.SENTRY_TRACES_SAMPLE_RATE ?? '0.05',
    ),
  });
}

// PRD-7: catch errors that escape the framework. Promise rejections without
// `.catch()` and synchronous throws outside request scope would otherwise
// kill the process silently. We log + exit so the container restarts (via
// docker compose restart policy / HEALTHCHECK), preserving observability.
const processLogger = new Logger('Process');
process.on('unhandledRejection', (reason) => {
  processLogger.error(
    'Unhandled promise rejection',
    reason instanceof Error ? reason.stack : String(reason),
  );
});
process.on('uncaughtException', (err) => {
  processLogger.error('Uncaught exception, exiting', err.stack);
  process.exit(1);
});

async function bootstrap() {
  // bufferLogs lets Nest queue early log lines until our pino logger is wired.
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(PinoLogger));
  const configService = app.get(ConfigService);
  const logger = new Logger('Bootstrap');

  const nodeEnv = configService.get<string>('nodeEnv') ?? 'development';
  const allowedOrigins = configService.get<string[]>('allowedOrigins') ?? [];

  app.enableCors({
    origin: allowedOrigins.length > 0 ? allowedOrigins : false,
    credentials: true,
  });
  app.use(
    helmet({
      // HSTS only takes effect over HTTPS — set it now so the header is
      // present once the reverse-proxy in front terminates TLS.
      hsts: {
        maxAge: 31_536_000, // 1 year
        includeSubDomains: true,
        preload: true,
      },
    }),
  );

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  app.useGlobalFilters(new HttpExceptionFilter());
  // (LoggingInterceptor removed — pino-http auto-logs every request now.)

  if (nodeEnv !== 'production') {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('SOS Security API')
      .setDescription('SOS Emergency System — quick response group backend')
      .setVersion('1.0')
      .addBearerAuth()
      .build();

    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('api/docs', app, document);
    logger.log(`Swagger docs available at /api/docs`);
  }

  // Lets Nest fire OnModuleDestroy / OnApplicationShutdown on SIGTERM/SIGINT
  // so DB / Redis / WS gateway can drain their connections.
  app.enableShutdownHooks();

  const shutdown = async (signal: string) => {
    logger.warn(`Received ${signal}, closing app gracefully...`);
    try {
      await app.close();
      process.exit(0);
    } catch (err) {
      logger.error('Error during graceful shutdown', err as Error);
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  const port = configService.get<number>('port') || 3000;
  await app.listen(port);

  logger.log(`Application running on port ${port} (env=${nodeEnv})`);
  logger.log(`CORS origins: ${allowedOrigins.join(', ') || '(none — locked down)'}`);
}

void bootstrap();
