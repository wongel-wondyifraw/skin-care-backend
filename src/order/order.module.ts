import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Order } from './order.entity.js';
import { Product } from '../product/product.entity.js';
import { OrderService } from './order.service.js';
import { OrderController } from './order.controller.js';
import { TelegramModule } from '../telegram/telegram.module.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([Order, Product]),
    forwardRef(() => TelegramModule),
  ],
  providers: [OrderService],
  controllers: [OrderController],
  exports: [OrderService],
})
export class OrderModule {}
