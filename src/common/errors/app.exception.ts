import { HttpException, HttpStatus } from '@nestjs/common';
import { ErrorCodeValue } from './error-codes';

/**
 * Исключение с машинным кодом. `debugMessage` английский и адресован логам —
 * пользовательский текст клиент подбирает по `code` из своей локали.
 *
 * Дополнительные поля (`details`) уходят в ответ как есть: например число
 * незакрытых вызовов, чтобы клиенту было что подставить в свою строку.
 */
export class AppException extends HttpException {
  constructor(
    code: ErrorCodeValue,
    status: HttpStatus,
    debugMessage: string,
    details?: Record<string, unknown>,
  ) {
    super({ code, message: debugMessage, ...(details ?? {}) }, status);
  }
}

export const badRequest = (
  code: ErrorCodeValue,
  debugMessage: string,
  details?: Record<string, unknown>,
) => new AppException(code, HttpStatus.BAD_REQUEST, debugMessage, details);

export const forbidden = (
  code: ErrorCodeValue,
  debugMessage: string,
  details?: Record<string, unknown>,
) => new AppException(code, HttpStatus.FORBIDDEN, debugMessage, details);

export const notFound = (
  code: ErrorCodeValue,
  debugMessage: string,
  details?: Record<string, unknown>,
) => new AppException(code, HttpStatus.NOT_FOUND, debugMessage, details);

export const conflict = (
  code: ErrorCodeValue,
  debugMessage: string,
  details?: Record<string, unknown>,
) => new AppException(code, HttpStatus.CONFLICT, debugMessage, details);
