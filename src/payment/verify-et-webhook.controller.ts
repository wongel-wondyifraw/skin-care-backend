import {
  Body,
  Controller,
  HttpCode,
  Logger,
  Post,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Order } from '../order/order.entity.js';
import { OrderService } from '../order/order.service.js';
import { VerifyEtService } from './verify-et.service.js';
import { NotificationService } from '../notification/notification.service.js';

@Controller('api/webhooks')
export class VerifyEtWebhookController {
  private readonly logger = new Logger(VerifyEtWebhookController.name);

  constructor(
    @InjectRepository(Order)
    private readonly orderRepository: Repository<Order>,
    @Inject(forwardRef(() => OrderService))
    private readonly orderService: OrderService,
    private readonly verifyEtService: VerifyEtService,
    private readonly notificationService: NotificationService,
  ) {}

  @Post('verify-et')
  @HttpCode(200)
  async handleWebhook(@Body() payload: Record<string, unknown>) {
    const requestId =
      typeof payload.requestId === 'string'
        ? payload.requestId
        : typeof (payload.data as Record<string, unknown> | undefined)
              ?.requestId === 'string'
          ? String((payload.data as Record<string, unknown>).requestId)
          : '';
    if (!requestId) {
      this.logger.warn('Webhook received without requestId');
      return { received: true };
    }

    this.logger.log(`Verify.ET webhook received: requestId=${requestId}`);

    const orders = await this.orderRepository.find({
      where: { verifyEtRequestId: requestId },
      relations: { customer: true, product: true },
    });

    if (!orders.length) {
      // Expected when checkout already polled to completion before webhook
      this.logger.log(
        `No pending orders for requestId=${requestId} (likely already resolved)`,
      );
      return { received: true };
    }

    const totalAdvance = orders.reduce(
      (sum, o) => sum + (Number(o.advancePaymentAmount) || 0),
      0,
    );
    const result = this.verifyEtService.parseCompletedResponse(
      payload,
      totalAdvance,
    );

    for (const order of orders) {
      order.verifyEtStatus = result.outcome;
      order.verifyEtRawResponse = result.rawResponse ?? null;
      await this.orderRepository.save(order);

      if (
        result.outcome === 'verified' &&
        (order.status === 'payment_submitted' ||
          order.status === 'awaiting_payment')
      ) {
        await this.orderService.updateStatus(order.id, 'confirmed');
      }
    }

    if (result.outcome !== 'verified') {
      const first = orders[0];
      await this.notificationService.create({
        type: 'payment_submitted',
        title: 'Auto-verification failed (webhook)',
        body: `${first.customer?.fullName ?? 'Customer'} · ${first.product?.name ?? 'Product'} — ${result.failureReason || result.outcome}`,
        orderId: first.id,
        href: '/admin/orders',
      });
    }

    return { received: true };
  }
}
