import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Customer } from './customer.entity.js';
import { CustomerMessage } from './customer-message.entity.js';
import { CustomerService } from './customer.service.js';
import { CustomerMessageService } from './customer-message.service.js';
import { CustomerController } from './customer.controller.js';
import { TelegramModule } from '../telegram/telegram.module.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([Customer, CustomerMessage]),
    forwardRef(() => TelegramModule),
  ],
  providers: [CustomerService, CustomerMessageService],
  controllers: [CustomerController],
  exports: [CustomerService, CustomerMessageService],
})
export class CustomerModule {}
