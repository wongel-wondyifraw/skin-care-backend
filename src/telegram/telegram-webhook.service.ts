import { INestApplication, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectBot } from 'nestjs-telegraf';
import { Telegraf } from 'telegraf';

@Injectable()
export class TelegramWebhookService {
  private readonly logger = new Logger(TelegramWebhookService.name);
  private shutdownPatchInstalled = false;

  constructor(
    @InjectBot() private readonly bot: Telegraf,
    private readonly config: ConfigService,
  ) {}

  isEnabled(): boolean {
    return (
      (this.config.get<string>('TELEGRAM_USE_WEBHOOK') || '').toLowerCase() === 'true'
    );
  }

  /**
   * Mount Telegraf's webhook middleware onto the NestJS/Express app.
   * Must be called in main.ts BEFORE app.listen().
   *
   * Note: we register at the application root (not at the path prefix) so
   * that Telegraf's internal URL comparison sees the full path unchanged.
   */
  mount(app: INestApplication): void {
    if (!this.isEnabled()) return;

    const path = this.webhookPath();
    this.installShutdownPatch();
    app.use(this.bot.webhookCallback(path));
    this.logger.log(`Telegram webhook middleware mounted at ${path}`);
  }

  /**
   * Registers the webhook URL with Telegram.
   * Must be called AFTER app.listen() so the port is open.
   */
  async syncWebhook(): Promise<void> {
    if (!this.isEnabled()) return;

    const url = this.webhookUrl();
    await this.bot.telegram.setWebhook(url, {
      drop_pending_updates: false,
      max_connections: 40,
    });
    this.logger.log(`Telegram webhook registered: ${url}`);
  }

  private webhookPath(): string {
    const raw = this.config.get<string>('TELEGRAM_WEBHOOK_PATH') || '/telegram/webhook';
    const trimmed = raw.trim();
    return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  }

  private webhookUrl(): string {
    const base = (this.config.get<string>('TELEGRAM_WEBHOOK_URL') || '').trim();
    if (!base) {
      throw new Error(
        'TELEGRAM_WEBHOOK_URL must be set in .env when TELEGRAM_USE_WEBHOOK=true',
      );
    }
    return `${base.replace(/\/+$/, '')}${this.webhookPath()}`;
  }

  /**
   * Telegraf throws "Bot is not running!" when .stop() is called in webhook
   * mode (because it was never started via .launch()). Patch it to swallow
   * that specific error so NestJS shutdown hooks don't crash.
   */
  private installShutdownPatch(): void {
    if (this.shutdownPatchInstalled) return;

    const originalStop = this.bot.stop.bind(this.bot);
    this.bot.stop = (reason?: string) => {
      try {
        return originalStop(reason);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message === 'Bot is not running!') {
          this.logger.log(
            'Telegraf stop() called in webhook mode — safe to ignore.',
          );
          return;
        }
        throw err;
      }
    };

    this.shutdownPatchInstalled = true;
  }
}
