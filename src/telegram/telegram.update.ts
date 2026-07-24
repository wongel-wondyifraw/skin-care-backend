import { Logger } from '@nestjs/common';
import { Ctx, Start, Update } from 'nestjs-telegraf';
import { Context } from 'telegraf';

@Update()
export class TelegramUpdate {
  private readonly logger = new Logger(TelegramUpdate.name);

  /**
   * Fires when a user opens the bot and taps Start (or sends /start).
   * ctx.reply() delivers the message directly through Telegraf — no
   * manual HTTP calls, no domain registration needed beyond the webhook URL.
   */
  @Start()
  async onStart(@Ctx() ctx: Context) {
    const firstName = ctx.from?.first_name ?? 'there';
    const userId = ctx.from?.id;

    this.logger.log(`/start received from userId=${userId} (${firstName})`);

    await ctx.reply(
      `Welcome to Medaf Skin Care, ${firstName}! 🌿✨\n\n` +
        `We offer premium, carefully curated skincare products tailored for every skin type.\n\n` +
        `What you can do here:\n` +
        `🛒 Browse our product catalogue\n` +
        `💧 Discover routines for your skin type\n` +
        `📦 Stay updated on new arrivals and offers\n\n` +
        `Feel free to reach out — we are always happy to help! 😊`,
    );
  }
}
