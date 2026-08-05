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
      salesRaw,
      recentOrders,
    ] = await Promise.all([
      this.productRepository.count(),
      this.categoryRepository.count(),
      this.skinTypeRepository.count(),
      this.customerRepository.count(),
      this.orderRepository.count(),
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
      sales: Number(salesRaw?.total ?? 0),
      recentOrders,
    };
  }
}
