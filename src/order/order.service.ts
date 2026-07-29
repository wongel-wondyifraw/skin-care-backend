import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Order, OrderStatus } from './order.entity.js';
import { Product } from '../product/product.entity.js';

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface OrderListQuery {
  page?: number;
  pageSize?: number;
  search?: string;
  status?: OrderStatus | 'all';
}

@Injectable()
export class OrderService {
  constructor(
    @InjectRepository(Order)
    private readonly orderRepository: Repository<Order>,
    @InjectRepository(Product)
    private readonly productRepository: Repository<Product>,
  ) {}

  private hydrateQuery() {
    return this.orderRepository
      .createQueryBuilder('order')
      .leftJoinAndSelect('order.customer', 'customer')
      .leftJoinAndSelect('order.product', 'product')
      .orderBy('order.createdAt', 'DESC');
  }

  async findAll(): Promise<Order[]> {
    return this.hydrateQuery().getMany();
  }

  async findPage(query: OrderListQuery): Promise<PaginatedResult<Order>> {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(50, Math.max(1, query.pageSize ?? 12));

    const qb = this.hydrateQuery()
      .skip((page - 1) * pageSize)
      .take(pageSize);

    const search = query.search?.trim();
    if (search) {
      qb.andWhere(
        '(LOWER(customer.fullName) LIKE :search OR LOWER(product.name) LIKE :search OR LOWER(COALESCE(order.deliveryAddress, \'\')) LIKE :search)',
        { search: `%${search.toLowerCase()}%` },
      );
    }

    if (query.status && query.status !== 'all') {
      qb.andWhere('order.status = :status', { status: query.status });
    }

    const [items, total] = await qb.getManyAndCount();
    return { items, total, page, pageSize };
  }

  async findOne(id: string): Promise<Order> {
    const order = await this.hydrateQuery()
      .where('order.id = :id', { id })
      .getOne();
    if (!order) {
      throw new NotFoundException(`Order with ID ${id} not found`);
    }
    return order;
  }

  async create(data: {
    customerId: string;
    productId: string;
    cost: number;
    quantity: number;
    deliveryAddress?: string | null;
    status?: OrderStatus;
  }): Promise<Order> {
    const quantity = Math.floor(Number(data.quantity));
    if (!Number.isFinite(quantity) || quantity < 1) {
      throw new BadRequestException('Quantity must be at least 1');
    }

    const order = this.orderRepository.create({
      customerId: data.customerId,
      productId: data.productId,
      cost: data.cost,
      quantity,
      deliveryAddress: data.deliveryAddress?.trim() || null,
      status: data.status ?? 'pending',
    });
    const saved = await this.orderRepository.save(order);
    return this.findOne(saved.id);
  }

  /**
   * pending → delivered: subtract order.quantity from product stock
   * pending → cancelled: no stock change
   */
  async updateStatus(id: string, status: OrderStatus): Promise<Order> {
    if (status !== 'delivered' && status !== 'cancelled') {
      throw new BadRequestException('Status must be delivered or cancelled');
    }

    const order = await this.findOne(id);
    if (order.status !== 'pending') {
      throw new BadRequestException(
        `Only pending orders can be updated (current: ${order.status})`,
      );
    }

    if (status === 'delivered') {
      const product = await this.productRepository.findOne({
        where: { id: order.productId },
      });
      if (!product) {
        throw new NotFoundException(
          `Product for order ${id} was not found`,
        );
      }
      const qty = Math.max(1, order.quantity ?? 1);
      product.stock = Math.max(0, (product.stock ?? 0) - qty);
      await this.productRepository.save(product);
    }

    order.status = status;
    await this.orderRepository.save(order);
    return this.findOne(id);
  }

  async count(): Promise<number> {
    return this.orderRepository.count();
  }
}
