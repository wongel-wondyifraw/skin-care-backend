import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Order } from './order.entity.js';
import { Product } from '../product/product.entity.js';
import { PickupLocation } from '../pickup-location/pickup-location.entity.js';
import { OrderService } from './order.service.js';
import { OrderController } from './order.controller.js';
import { TelegramModule } from '../telegram/telegram.module.js';
import { NotificationModule } from '../notification/notification.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { PaymentModule } from '../payment/payment.module.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([Order, Product, PickupLocation]),
    forwardRef(() => TelegramModule),
    NotificationModule,
    forwardRef(() => SettingsModule),
    forwardRef(() => PaymentModule),
  ],
  providers: [OrderService],
  controllers: [OrderController],
  exports: [OrderService],
})
export class OrderModule {}
