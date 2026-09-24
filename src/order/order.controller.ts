import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { OrderService } from './order.service.js';
import { OrderStatus } from './order.entity.js';

@UseGuards(JwtAuthGuard)
@Controller('orders')
export class OrderController {
  constructor(private readonly orderService: OrderService) {}

  @Get()
  findAll(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('search') search?: string,
    @Query('status') status?: OrderStatus | 'all',
  ) {
    return this.orderService.findPage({
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
      search,
      status,
    });
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.orderService.findOne(id);
  }

  @Patch(':id/status')
  updateStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { status: OrderStatus },
  ) {
    const validStatuses: OrderStatus[] = [
      'awaiting_payment',
      'payment_submitted',
      'pending',
      'confirmed',
      'delivered',
      'cancelled',
    ];
    if (!validStatuses.includes(body?.status)) {
      throw new BadRequestException('Invalid order status');
    }
    return this.orderService.updateStatus(id, body.status);
  }

  @Patch(':id/verify-payment')
  verifyPayment(@Param('id', ParseUUIDPipe) id: string) {
    return this.orderService.verifyPayment(id);
  }

  @Patch(':id/auto-verify')
  async autoVerify(@Param('id', ParseUUIDPipe) id: string) {
    return this.orderService.triggerAutoVerify(id);
  }

  @Patch(':id/reject-payment')
  rejectPayment(@Param('id', ParseUUIDPipe) id: string) {
    return this.orderService.rejectPayment(id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.orderService.remove(id);
  }
}
