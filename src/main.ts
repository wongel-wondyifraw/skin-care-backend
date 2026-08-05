import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module.js';
import { GlobalHttpExceptionFilter } from './common/http-exception.filter.js';
import { TelegramWebhookService } from './telegram/telegram-webhook.service.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.useGlobalFilters(new GlobalHttpExceptionFilter());
  app.use(helmet());
  app.use(cookieParser());

  const origins = (process.env.FRONTEND_URL || 'http://localhost:3000')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  app.enableCors({
    origin: origins.length === 1 ? origins[0] : origins,
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
    }),
  );

  app.setGlobalPrefix('api', { exclude: ['health'] });

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
bootstrap().catch((err) => {
  console.error('Bootstrap failed:', err);
  process.exit(1);
});
