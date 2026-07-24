import { Controller, Post, Body, BadRequestException } from '@nestjs/common';
import { TelegramService } from './telegram.service.js';

/**
 * REST endpoints for outbound Telegram messages.
 * The inbound webhook (user → bot) is handled by TelegramUpdate via Telegraf,
 * NOT by a controller — Telegraf owns that route.
 */
@Controller('telegram')
export class TelegramController {
  constructor(private readonly telegramService: TelegramService) {}

  /**
   * POST /api/telegram/test-greeting
   * Sends a one-off message to a given chat ID.
   * Useful for smoke-testing the bot connection without opening Telegram.
   *
   * Body: { "chatId": "123456789" }
   */
  @Post('test-greeting')
  async testGreeting(@Body() body: { chatId: string }) {
    if (!body.chatId) {
      throw new BadRequestException('chatId is required in the request body');
    }

    const text =
      `Greetings from Medaf Skin Care! 🌿✨\n\n` +
      `This is a test notification confirming that the Telegram Bot API ` +
      `connection is active and configured correctly.`;

    await this.telegramService.sendMessage(body.chatId, text);

    return { success: true, message: 'Test greeting sent successfully' };
  }
}
