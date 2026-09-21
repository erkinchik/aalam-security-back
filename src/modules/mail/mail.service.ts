import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

/**
 * Отправка писем через SMTP.
 *
 * Провайдер намеренно не зашит: подойдёт любой с бесплатным тарифом — Brevo,
 * Resend, Яндекс 360, — достаточно заполнить SMTP_* в окружении. Если они не
 * заданы, сервис работает как выключенный: `isEnabled` возвращает false, и
 * вызывающий сам решает, что показать пользователю, вместо того чтобы обещать
 * письмо, которое некому отправить.
 */
@Injectable()
export class MailService implements OnModuleInit {
  private readonly logger = new Logger(MailService.name);
  private transporter: nodemailer.Transporter | null = null;
  private from = '';

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    const host = this.config.get<string>('mail.host');
    const user = this.config.get<string>('mail.user');
    const password = this.config.get<string>('mail.password');

    if (!host || !user || !password) {
      this.logger.warn(
        'SMTP is not configured (SMTP_HOST/SMTP_USER/SMTP_PASSWORD) — outgoing mail is disabled',
      );
      return;
    }

    const port = this.config.get<number>('mail.port') ?? 587;
    this.from = this.config.get<string>('mail.from') || user;
    this.transporter = nodemailer.createTransport({
      host,
      port,
      // 465 — неявный TLS, 587 — STARTTLS. Провайдеры с бесплатным тарифом
      // обычно дают 587.
      secure: port === 465,
      auth: { user, pass: password },
    });
    this.logger.log(`SMTP configured: ${host}:${port}`);
  }

  isEnabled(): boolean {
    return this.transporter !== null;
  }

  /**
   * Возвращает true, если письмо ушло. Ошибку не пробрасываем: для вызывающего
   * это фоновая доставка, а не причина завалить весь запрос.
   */
  async send(to: string, subject: string, text: string): Promise<boolean> {
    if (!this.transporter) return false;
    try {
      await this.transporter.sendMail({ from: this.from, to, subject, text });
      return true;
    } catch (err) {
      // Адрес не логируем целиком: письмо и так ушло конкретному человеку.
      this.logger.error(`Failed to send "${subject}"`, err as Error);
      return false;
    }
  }
}
