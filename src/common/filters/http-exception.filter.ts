import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import * as Sentry from '@sentry/node';
import { Request, Response } from 'express';

const HTTP_STATUS_MESSAGES: Record<number, string> = {
  [HttpStatus.BAD_REQUEST]: 'Bad Request',
  [HttpStatus.UNAUTHORIZED]: 'Unauthorized',
  [HttpStatus.FORBIDDEN]: 'Forbidden',
  [HttpStatus.NOT_FOUND]: 'Not Found',
  [HttpStatus.CONFLICT]: 'Conflict',
  [HttpStatus.INTERNAL_SERVER_ERROR]: 'Internal Server Error',
};

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    const rawResponse =
      exception instanceof HttpException
        ? exception.getResponse()
        : 'Internal server error';

    if (status >= 500) {
      this.logger.error(
        `${request.method} ${request.url} ${status}`,
        exception instanceof Error ? exception.stack : undefined,
      );
      // PRD-6: ship 5xx to Sentry. No-op if Sentry wasn't initialised (no DSN).
      Sentry.captureException(exception, {
        tags: { route: `${request.method} ${request.route?.path ?? request.url}` },
      });
    }

    const { message, errors } = this.normalizeResponse(rawResponse, status);
    const errorLabel =
      typeof rawResponse === 'object' &&
      rawResponse !== null &&
      'error' in rawResponse &&
      typeof (rawResponse as Record<string, unknown>).error === 'string'
        ? (rawResponse as Record<string, unknown>).error
        : HTTP_STATUS_MESSAGES[status] ?? 'Error';

    response.status(status).json({
      statusCode: status,
      error: errorLabel,
      message,
      ...(errors && errors.length > 0 && { errors }),
      timestamp: new Date().toISOString(),
      path: request.url,
    });
  }

  private normalizeResponse(
    raw: string | object,
    status: number,
  ): { message: string; errors?: string[] } {
    if (typeof raw === 'string') {
      return { message: raw };
    }

    const obj = raw as Record<string, unknown>;
    const msg = obj.message;

    if (Array.isArray(msg)) {
      return {
        message: status === 400 ? 'Validation failed' : 'Request failed',
        errors: msg.map((m) => (typeof m === 'string' ? m : String(m))),
      };
    }

    if (typeof msg === 'string') {
      return { message: msg };
    }

    return {
      message: obj.error && typeof obj.error === 'string' ? obj.error : 'An error occurred',
    };
  }
}
