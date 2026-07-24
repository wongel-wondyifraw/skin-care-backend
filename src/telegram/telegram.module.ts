import { Logger, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TelegrafModule } from 'nestjs-telegraf';
import { TelegramService } from './telegram.service.js';
import { TelegramController } from './telegram.controller.js';
import { TelegramWebhookService } from './telegram-webhook.service.js';
import { TelegramUpdate } from './telegram.update.js';

@Module({
  imports: [
    ConfigModule,
    TelegrafModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const token = config.get<string>('TELEGRAM_BOT_TOKEN');
        if (!token) throw new Error('TELEGRAM_BOT_TOKEN is missing from .env');

        const useWebhook =
          (config.get<string>('TELEGRAM_USE_WEBHOOK') || '').toLowerCase() === 'true';

        new Logger('TelegramModule').log(
          `Telegram mode: ${useWebhook ? 'webhook (Telegraf polling disabled)' : 'polling'}`,
        );

        return {
          token,
          // When using webhooks we mount the handler ourselves in main.ts,
          // so tell Telegraf NOT to start its own polling loop.
          launchOptions: useWebhook ? false : undefined,
        };
      },
    }),
  ],
  providers: [TelegramService, TelegramWebhookService, TelegramUpdate],
  controllers: [TelegramController],
  exports: [TelegramService, TelegramWebhookService],
})
export class TelegramModule {}
