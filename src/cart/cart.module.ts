import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { Cart } from './cart.entity.js';
import { Product } from '../product/product.entity.js';
import { CartService } from './cart.service.js';
import { CartReminderService } from './cart-reminder.service.js';
import { OrderModule } from '../order/order.module.js';
import { TelegramModule } from '../telegram/telegram.module.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([Cart, Product]),
    ConfigModule,
    forwardRef(() => OrderModule),
    forwardRef(() => TelegramModule),
  ],
  providers: [CartService, CartReminderService],
  exports: [CartService, CartReminderService],
})
export class CartModule {}
