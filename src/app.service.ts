import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Product } from './product/product.entity.js';
import { Category } from './category/category.entity.js';
import { SkinType } from './skin-type/skin-type.entity.js';
import { Customer } from './customer/customer.entity.js';
import { Order } from './order/order.entity.js';

@Injectable()
export class AppService {
  constructor(
    @InjectRepository(Product)
    private readonly productRepository: Repository<Product>,
    @InjectRepository(Category)
    private readonly categoryRepository: Repository<Category>,
    @InjectRepository(SkinType)
    private readonly skinTypeRepository: Repository<SkinType>,
    @InjectRepository(Customer)
    private readonly customerRepository: Repository<Customer>,
    @InjectRepository(Order)
    private readonly orderRepository: Repository<Order>,
  ) {}

  getHealth() {
    return { status: 'ok', uptime: process.uptime() };
  }

  async getDashboardSummary() {
    const [
      products,
      categories,
      skinTypes,
      customers,
      orders,
      halfVerifiedRaw,
      fullVerifiedRaw,
      halfCollectedRaw,
      revenueCollectedRaw,
      outstandingRaw,
      deliveredSalesRaw,
      recentOrders,
    ] = await Promise.all([
      this.productRepository.count(),
      this.categoryRepository.count(),
      this.skinTypeRepository.count(),
      this.customerRepository.count(),
      this.orderRepository
        .createQueryBuilder('order')
        .where('order.status != :cancelled', { cancelled: 'cancelled' })
        .getCount(),
      // Half payment verified (partial) — include legacy confirmed without stage
      this.orderRepository
        .createQueryBuilder('order')
        .where('order.status != :cancelled', { cancelled: 'cancelled' })
        .andWhere(
          `(order.paymentStage = 'partial' OR (
            (order.paymentStage IS NULL OR order.paymentStage = 'unpaid')
            AND order.paymentVerifiedAt IS NOT NULL
            AND order.status IN ('confirmed', 'delivered')
          ))`,
        )
        .getCount(),
      this.orderRepository
        .createQueryBuilder('order')
        .where('order.status != :cancelled', { cancelled: 'cancelled' })
        .andWhere(`order.paymentStage = 'full'`)
        .getCount(),
      // Sum of verified advances (amountPaid for partial, or advance for legacy)
      this.orderRepository
        .createQueryBuilder('order')
        .select(
          `COALESCE(SUM(
            CASE
              WHEN order.paymentStage = 'partial' THEN COALESCE(order.amountPaid, order.advancePaymentAmount, 0)
              WHEN order.paymentStage = 'full' THEN COALESCE(order.advancePaymentAmount, order.amountPaid * 0.5, 0)
              WHEN order.paymentVerifiedAt IS NOT NULL THEN COALESCE(order.advancePaymentAmount, 0)
              ELSE 0
            END
          ), 0)`,
          'total',
        )
        .where('order.status != :cancelled', { cancelled: 'cancelled' })
        .getRawOne<{ total: string }>(),
      this.orderRepository
        .createQueryBuilder('order')
        .select(
          `COALESCE(SUM(
            CASE
              WHEN order.paymentStage = 'full' THEN COALESCE(order.amountPaid, order.cost * order.quantity + COALESCE(order.deliveryFee, 0), 0)
              WHEN order.paymentStage = 'partial' THEN COALESCE(order.amountPaid, order.advancePaymentAmount, 0)
              WHEN order.paymentVerifiedAt IS NOT NULL THEN COALESCE(order.advancePaymentAmount, 0)
              ELSE 0
            END
          ), 0)`,
          'total',
        )
        .where('order.status != :cancelled', { cancelled: 'cancelled' })
        .getRawOne<{ total: string }>(),
      this.orderRepository
        .createQueryBuilder('order')
        .select(
          `COALESCE(SUM(
            GREATEST(
              (order.cost * order.quantity + COALESCE(order.deliveryFee, 0))
              - COALESCE(NULLIF(order.amountPaid, 0), order.advancePaymentAmount, 0),
              0
            )
          ), 0)`,
          'total',
        )
        .where('order.status != :cancelled', { cancelled: 'cancelled' })
        .andWhere(
          `(order.paymentStage = 'partial' OR (
            (order.paymentStage IS NULL OR order.paymentStage = 'unpaid')
            AND order.paymentVerifiedAt IS NOT NULL
            AND order.status IN ('confirmed', 'delivered')
          ))`,
        )
        .getRawOne<{ total: string }>(),
      this.orderRepository
        .createQueryBuilder('order')
        .select('COALESCE(SUM(order.cost * order.quantity), 0)', 'total')
        .where('order.status = :status', { status: 'delivered' })
        .getRawOne<{ total: string }>(),
      this.orderRepository.find({
        relations: { customer: true, product: true },
        order: { createdAt: 'DESC' },
        take: 8,
      }),
    ]);

    return {
      products,
      categories,
      skinTypes,
      customers,
      orders,
      /** @deprecated use revenueCollected — kept for older clients */
      sales: Number(deliveredSalesRaw?.total ?? 0),
      halfPaymentVerifiedOrders: halfVerifiedRaw,
      fullPaymentVerifiedOrders: fullVerifiedRaw,
      halfPaymentCollected: Number(halfCollectedRaw?.total ?? 0),
      revenueCollected: Number(revenueCollectedRaw?.total ?? 0),
      outstandingRemaining: Number(outstandingRaw?.total ?? 0),
      deliveredSales: Number(deliveredSalesRaw?.total ?? 0),
      recentOrders,
    };
  }
}
