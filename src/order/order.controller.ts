import {
  BadRequestException,
  Body,
  Controller,
  Get,
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
    if (
      page !== undefined ||
      pageSize !== undefined ||
      search !== undefined ||
      status !== undefined
    ) {
      return this.orderService.findPage({
        page: page ? Number(page) : undefined,
        pageSize: pageSize ? Number(pageSize) : undefined,
        search,
        status,
      });
    }

    return this.orderService.findAll();
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
    if (body?.status !== 'delivered' && body?.status !== 'cancelled') {
      throw new BadRequestException(
        'Status must be delivered or cancelled',
      );
    }
    return this.orderService.updateStatus(id, body.status);
  }
}
