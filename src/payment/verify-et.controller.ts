import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { VerifyEtService } from './verify-et.service.js';
import { Order } from '../order/order.entity.js';

@UseGuards(JwtAuthGuard)
@Controller('admin/verify-et')
export class VerifyEtController {
  constructor(
    private readonly verifyEtService: VerifyEtService,
    @InjectRepository(Order)
    private readonly orderRepository: Repository<Order>,
  ) {}

  @Get('dashboard')
  async getDashboard() {
    const data = await this.verifyEtService.getDashboardData();
    if (!data) return null;

    const historyItems = Array.isArray(data.history?.data)
      ? (data.history.data as Record<string, unknown>[])
      : [];
    const requestIds = historyItems
      .map((item) => String(item.requestId || item.id || ''))
      .filter(Boolean);

    const localOrders =
      requestIds.length > 0
        ? await this.orderRepository.find({
            where: { verifyEtRequestId: In(requestIds) },
            relations: { customer: true, product: true },
            order: { createdAt: 'DESC' },
          })
        : [];

    const ordersByRequest = new Map<string, typeof localOrders>();
    for (const order of localOrders) {
      const key = order.verifyEtRequestId || '';
      if (!key) continue;
      const list = ordersByRequest.get(key) ?? [];
      list.push(order);
      ordersByRequest.set(key, list);
    }

    const verifications = historyItems.map((item) => {
      const requestId = String(item.requestId || item.id || '');
      const linked = ordersByRequest.get(requestId) ?? [];
      return {
        ...item,
        requestId,
        localOrders: linked.map((o) => ({
          id: o.id,
          status: o.status,
          verifyEtStatus: o.verifyEtStatus,
          paymentEvidence: o.paymentEvidence,
          advancePaymentAmount: o.advancePaymentAmount,
          paymentMethod: o.paymentMethod,
          createdAt: o.createdAt,
          customerName: o.customer?.fullName ?? null,
          productName: o.product?.name ?? null,
          raw: o.verifyEtRawResponse,
        })),
      };
    });

    return {
      ...data,
      verifications,
    };
  }

  /** Full live Verify.ET payload + linked local orders */
  @Get('verifications/:requestId')
  async getVerification(@Param('requestId') requestId: string) {
    const live = await this.verifyEtService.getVerificationDetail(requestId);
    const orders = await this.orderRepository.find({
      where: { verifyEtRequestId: requestId },
      relations: { customer: true, product: true },
    });

    return {
      requestId,
      live,
      localOrders: orders.map((o) => ({
        id: o.id,
        status: o.status,
        verifyEtStatus: o.verifyEtStatus,
        paymentEvidence: o.paymentEvidence,
        advancePaymentAmount: o.advancePaymentAmount,
        paymentMethod: o.paymentMethod,
        paymentVerifiedAt: o.paymentVerifiedAt,
        createdAt: o.createdAt,
        customerName: o.customer?.fullName ?? null,
        customerPhone: o.customer?.phone ?? null,
        productName: o.product?.name ?? null,
        raw: o.verifyEtRawResponse,
      })),
    };
  }
}
