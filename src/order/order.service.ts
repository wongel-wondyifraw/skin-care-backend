import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  forwardRef,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Order, OrderStatus } from './order.entity.js';
import { Product } from '../product/product.entity.js';
import { TelegramService } from '../telegram/telegram.service.js';

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
    @Inject(forwardRef(() => TelegramService))
    private readonly telegramService: TelegramService,
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

  async findRecent(limit = 8): Promise<Order[]> {
    return this.hydrateQuery().take(Math.min(20, Math.max(1, limit))).getMany();
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
   * pending → delivered: subtract order.quantity from product stock + notify customer
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
    const updated = await this.findOne(id);

    if (status === 'delivered') {
      await this.notifyCustomerDelivered(updated);
    }

    return updated;
  }

  private async notifyCustomerDelivered(order: Order): Promise<void> {
    const telegramId = order.customer?.telegramId;
    if (telegramId == null) return;

    const qty = order.quantity ?? 1;
    const unit = Number(order.cost) || 0;
    const total = unit * qty;
    const productName = order.product?.name ?? 'your product';
    const name = order.customer?.fullName ?? 'there';

    const text =
      `✅ Delivery confirmed, ${name}!\n\n` +
      `Your order has been marked as delivered.\n\n` +
      `🌿 ${productName}\n` +
      `📦 Qty: ${qty}\n` +
      `💰 ${total.toFixed(2)} ETB\n\n` +
      `Thank you for shopping with Medaf Skin Care! 🌿`;

    await this.telegramService.sendMessageSafe(String(telegramId), text);
  }

  async remove(id: string): Promise<void> {
    const result = await this.orderRepository.delete(id);
    if (result.affected === 0) {
      throw new NotFoundException(`Order with ID ${id} not found`);
    }
  }

  async count(): Promise<number> {
    return this.orderRepository.count();
  }

  /** Sum of (unit cost × quantity) for delivered orders */
  async getDeliveredSalesTotal(): Promise<number> {
    const raw = await this.orderRepository
      .createQueryBuilder('order')
      .select('COALESCE(SUM(order.cost * order.quantity), 0)', 'total')
      .where('order.status = :status', { status: 'delivered' })
      .getRawOne<{ total: string }>();

    return Number(raw?.total ?? 0);
  }
}
