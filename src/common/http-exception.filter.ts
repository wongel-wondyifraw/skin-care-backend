import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { type Response } from 'express';

const SAFE_BY_STATUS: Record<number, string> = {
  400: 'The request could not be completed. Please check your input and try again.',
  401: 'Authentication required. Please sign in again.',
  403: 'You do not have permission to perform this action.',
  404: 'The requested item could not be found.',
  409: 'This item already exists.',
  413: 'The uploaded file is too large.',
  422: 'Some of the submitted data is invalid.',
  429: 'Too many requests. Please wait a moment and try again.',
  500: 'Something went wrong. Please try again later.',
};

const SENSITIVE =
  /password|token|secret|sql|stack|exception|econn|errno|postgres|typeorm|query failed|connection refused|enotfound|internal server/i;

@Catch()
export class GlobalHttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalHttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let rawMessage: string | string[] = SAFE_BY_STATUS[500];

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'string') {
        rawMessage = body;
      } else if (body && typeof body === 'object' && 'message' in body) {
        rawMessage = (body as { message: string | string[] }).message;
      }
    } else if (exception instanceof Error) {
      this.logger.error(exception.message, exception.stack);
      rawMessage = SAFE_BY_STATUS[500];
    } else {
      this.logger.error(`Unhandled non-error exception: ${String(exception)}`);
    }

    const message = this.sanitize(rawMessage, status);

    res.status(status).json({
      statusCode: status,
      message,
      error: HttpStatus[status] ?? 'Error',
    });
  }

  private sanitize(raw: string | string[], status: number): string {
    const joined = Array.isArray(raw) ? raw.join(', ') : String(raw ?? '');
    const trimmed = joined.trim();
    const fallback = SAFE_BY_STATUS[status] ?? SAFE_BY_STATUS[500];

    if (!trimmed) return fallback;
    if (status >= 500) return fallback;
    if (SENSITIVE.test(trimmed)) return fallback;
    if (trimmed.length > 180) return fallback;
    return trimmed;
  }
}
