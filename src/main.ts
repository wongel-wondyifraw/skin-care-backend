import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { TelegramWebhookService } from './telegram/telegram-webhook.service.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Allow the Next.js frontend to call this API
  app.enableCors({
    origin: ['http://localhost:3000', 'http://localhost:3001'],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: true,
  });

  // Global prefix so all routes live under /api
  app.setGlobalPrefix('api');

  // Mount the Telegraf webhook middleware BEFORE listen() so Express registers
  // the route before any requests arrive. In polling mode this is a no-op.
  const webhookService = app.get(TelegramWebhookService);
  webhookService.mount(app);

  const port = process.env.PORT ?? 4000;
  await app.listen(port);
  console.log(`Backend running on http://localhost:${port}/api`);

  // Register the webhook URL with Telegram AFTER the server is listening.
  // In polling mode this is a no-op.
  await webhookService.syncWebhook();
}
bootstrap();
