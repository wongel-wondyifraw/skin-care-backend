import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { InjectBot } from 'nestjs-telegraf';
import { Telegraf } from 'telegraf';

/**
 * Thin wrapper around bot.telegram.sendMessage().
 * Use this from other modules (e.g. order notifications) to push a
 * message to a known chat ID without going through the webhook flow.
 */
@Injectable()
export class TelegramService {
  private readonly logger = new Logger(TelegramService.name);

  constructor(@InjectBot() private readonly bot: Telegraf) {}

  async sendMessage(chatId: string, text: string): Promise<void> {
    try {
      await this.bot.telegram.sendMessage(chatId, text);
      this.logger.log(`Message sent to chatId=${chatId}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Failed to send message to chatId=${chatId}: ${message}`,
      );
      throw new BadRequestException(`Telegram send failed: ${message}`);
    }
  }

  /** Best-effort notify — logs failures and does not throw. */
  async sendMessageSafe(chatId: string, text: string): Promise<boolean> {
    try {
      await this.bot.telegram.sendMessage(chatId, text);
      this.logger.log(`Message sent to chatId=${chatId}`);
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Failed to send message to chatId=${chatId}: ${message}`,
      );
      return false;
    }
  }
}
