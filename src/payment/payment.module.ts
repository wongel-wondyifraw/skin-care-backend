import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SettingsModule } from '../settings/settings.module.js';
import { VerifyEtService } from './verify-et.service.js';
import { VerifyEtWebhookController } from './verify-et-webhook.controller.js';
import { VerifyEtController } from './verify-et.controller.js';
import { Order } from '../order/order.entity.js';
import { OrderModule } from '../order/order.module.js';
import { NotificationModule } from '../notification/notification.module.js';

@Module({
  imports: [
    ConfigModule,
    SettingsModule,
    TypeOrmModule.forFeature([Order]),
    OrderModule,
    NotificationModule,
  ],
  providers: [VerifyEtService],
  controllers: [VerifyEtWebhookController, VerifyEtController],
  exports: [VerifyEtService],
})
export class PaymentModule {}
