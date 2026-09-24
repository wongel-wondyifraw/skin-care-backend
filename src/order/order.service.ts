import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  forwardRef,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository, MoreThanOrEqual } from 'typeorm';
import { Order, OrderStatus, FulfilmentType } from './order.entity.js';
import { Product } from '../product/product.entity.js';
import { TelegramService } from '../telegram/telegram.service.js';
import { NotificationService } from '../notification/notification.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { VerifyEtService } from '../payment/verify-et.service.js';
import { GeminiService } from '../telegram/gemini.service.js';
import { effectiveUnitPrice } from '../product/product-pricing.js';

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

export interface CreateOrderCustomerOptions {
  deliveryAddress?: string | null;
  deliveryLat?: number | null;
  deliveryLon?: number | null;
  deliveryDistanceKm?: number | null;
  fulfilmentType?: FulfilmentType;
  pickupLocationId?: string | null;
  deliveryFee?: number;
  paymentMethod?: string | null;
  paymentEvidence?: string | null;
}

@Injectable()
export class OrderService {
  private readonly logger = new Logger(OrderService.name);

  constructor(
    @InjectRepository(Order)
    private readonly orderRepository: Repository<Order>,
    @InjectRepository(Product)
    private readonly productRepository: Repository<Product>,
    private readonly dataSource: DataSource,
    @Inject(forwardRef(() => TelegramService))
    private readonly telegramService: TelegramService,
    private readonly notificationService: NotificationService,
    @Inject(forwardRef(() => SettingsService))
    private readonly settingsService: SettingsService,
    @Inject(forwardRef(() => VerifyEtService))
    private readonly verifyEtService: VerifyEtService,
    @Inject(forwardRef(() => GeminiService))
    private readonly geminiService: GeminiService,
  ) {}

  private hydrateQuery() {
    return this.orderRepository
      .createQueryBuilder('order')
      .leftJoinAndSelect('order.customer', 'customer')
      .leftJoinAndSelect('order.product', 'product')
      .leftJoinAndSelect('order.pickupLocation', 'pickupLocation')
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
        "(LOWER(customer.fullName) LIKE :search OR LOWER(product.name) LIKE :search OR LOWER(COALESCE(order.deliveryAddress, '')) LIKE :search)",
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
    return this.hydrateQuery()
      .take(Math.min(20, Math.max(1, limit)))
      .getMany();
  }

  async findRecentByCustomer(
    customerId: string,
    sinceDate: Date,
  ): Promise<Order[]> {
    return this.orderRepository.find({
      where: {
        customerId,
        createdAt: MoreThanOrEqual(sinceDate),
      },
    });
  }

  async findPageForCustomer(
    customerId: string,
    query: OrderListQuery = {},
  ): Promise<PaginatedResult<Order>> {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(50, Math.max(1, query.pageSize ?? 20));

    const qb = this.hydrateQuery()
      .andWhere('order.customerId = :customerId', { customerId })
      .skip((page - 1) * pageSize)
      .take(pageSize);

    if (query.status && query.status !== 'all') {
      qb.andWhere('order.status = :status', { status: query.status });
    }

    const [items, total] = await qb.getManyAndCount();
    return { items, total, page, pageSize };
  }

  /**
   * Shop Mini App checkout — creates orders in the API (not via bot sendData).
   * Each line item becomes its own order row. Telegram gets a placement notice.
   */
  async createForCustomer(
    customerId: string,
    items: { productId: string; quantity: number }[],
    options?: CreateOrderCustomerOptions | string | null,
  ): Promise<Order[]> {
    if (!items?.length) {
      throw new BadRequestException('Add at least one product to order');
    }

    const opts: CreateOrderCustomerOptions =
      typeof options === 'string'
        ? { deliveryAddress: options }
        : options || {};

    const fulfilmentType: FulfilmentType = opts.fulfilmentType ?? 'delivery';
    const deliveryFee =
      fulfilmentType === 'pickup' ? 0 : Number(opts.deliveryFee) || 0;

    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);

    let subtotal = 0;
    const productInfos: {
      product: Product;
      quantity: number;
      unitPrice: number;
    }[] = [];
    for (const line of items) {
      const quantity = Math.floor(Number(line.quantity));
      if (!Number.isFinite(quantity) || quantity < 1) {
        throw new BadRequestException('Quantity must be at least 1');
      }

      const product = await this.productRepository.findOne({
        where: { id: line.productId },
      });
      if (!product) {
        throw new NotFoundException(`Product ${line.productId} not found`);
      }

      const unitPrice = effectiveUnitPrice(
        product.price,
        product.discountPercent,
        product.discountEndsAt,
      );
      subtotal += unitPrice * quantity;
      productInfos.push({ product, quantity, unitPrice });
    }

    const grandTotal = subtotal + deliveryFee;
    const totalAdvance = Math.round(grandTotal * 0.5 * 100) / 100;

    const initialStatus: OrderStatus = opts.paymentEvidence
      ? 'payment_submitted'
      : 'awaiting_payment';

    const created: Order[] = [];
    for (let i = 0; i < productInfos.length; i++) {
      const { product, quantity, unitPrice } = productInfos[i];
      const lineCost = unitPrice * quantity;
      const lineDeliveryFee = i === 0 ? deliveryFee : 0;
      const lineAdvance =
        subtotal > 0
          ? Math.round((lineCost + lineDeliveryFee) * 0.5 * 100) / 100
          : 0;

      const order = await this.create({
        customerId,
        productId: product.id,
        cost: unitPrice,
        quantity,
        deliveryAddress: opts.deliveryAddress ?? null,
        deliveryLat: opts.deliveryLat ?? null,
        deliveryLon: opts.deliveryLon ?? null,
        deliveryDistanceKm: opts.deliveryDistanceKm ?? null,
        status: initialStatus,
        fulfilmentType,
        pickupLocationId: opts.pickupLocationId ?? null,
        deliveryFee: lineDeliveryFee,
        expectedDeliveryDate: tomorrow,
        advancePaymentAmount: lineAdvance,
        paymentMethod: opts.paymentMethod ?? null,
        paymentEvidence: opts.paymentEvidence ?? null,
        paymentSubmittedAt: opts.paymentEvidence ? new Date() : null,
      });
      created.push(order);
    }

    void this.notifyCustomerShopOrdersPlaced(
      created,
      grandTotal,
      totalAdvance,
      deliveryFee,
    );

    // Attempt automatic payment verification if evidence was provided
    if (opts.paymentEvidence && opts.paymentMethod) {
      void this.autoVerifyPayment(
        created,
        opts.paymentMethod as 'bank' | 'telebirr',
        opts.paymentEvidence,
        totalAdvance,
      );
    }

    return created;
  }

  async findOneForCustomer(id: string, customerId: string): Promise<Order> {
    const order = await this.hydrateQuery()
      .where('order.id = :id', { id })
      .andWhere('order.customerId = :customerId', { customerId })
      .getOne();
    if (!order) {
      throw new NotFoundException(`Order with ID ${id} not found`);
    }
    return order;
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
    deliveryLat?: number | null;
    deliveryLon?: number | null;
    deliveryDistanceKm?: number | null;
    status?: OrderStatus;
    fulfilmentType?: FulfilmentType;
    pickupLocationId?: string | null;
    deliveryFee?: number;
    expectedDeliveryDate?: Date | null;
    advancePaymentAmount?: number;
    paymentMethod?: string | null;
    paymentEvidence?: string | null;
    paymentSubmittedAt?: Date | null;
  }): Promise<Order> {
    const quantity = Math.floor(Number(data.quantity));
    if (!Number.isFinite(quantity) || quantity < 1) {
      throw new BadRequestException('Quantity must be at least 1');
    }

    const savedId = await this.dataSource.transaction(async (em) => {
      const reserved = await em
        .createQueryBuilder()
        .update(Product)
        .set({ stock: () => `stock - ${quantity}` })
        .where('id = :id AND stock >= :qty', {
          id: data.productId,
          qty: quantity,
        })
        .execute();

      if (!reserved.affected) {
        throw new BadRequestException('Insufficient stock');
      }

      const order = em.create(Order, {
        customerId: data.customerId,
        productId: data.productId,
        cost: data.cost,
        quantity,
        deliveryAddress: data.deliveryAddress?.trim() || null,
        deliveryLat: data.deliveryLat ?? null,
        deliveryLon: data.deliveryLon ?? null,
        deliveryDistanceKm: data.deliveryDistanceKm ?? null,
        status: data.status ?? 'awaiting_payment',
        stockReserved: true,
        fulfilmentType: data.fulfilmentType ?? 'delivery',
        pickupLocationId: data.pickupLocationId ?? null,
        deliveryFee: data.deliveryFee ?? 0,
        expectedDeliveryDate: data.expectedDeliveryDate ?? null,
        advancePaymentAmount: data.advancePaymentAmount ?? 0,
        paymentMethod: data.paymentMethod ?? null,
        paymentEvidence: data.paymentEvidence ?? null,
        paymentSubmittedAt: data.paymentSubmittedAt ?? null,
      });
      const saved = await em.save(order);
      return saved.id;
    });

    const created = await this.findOne(savedId);
    void this.notifyAdminsOrderPlaced(created);
    return created;
  }

  async cancelForCustomer(id: string, customerId: string): Promise<Order> {
    await this.findOneForCustomer(id, customerId);
    return this.updateStatus(id, 'cancelled', { cancelledBy: 'customer' });
  }

  /** Customer submits payment evidence */
  async submitPaymentEvidence(
    orderId: string,
    customerId: string,
    evidence: {
      paymentMethod: 'bank' | 'telebirr';
      paymentEvidence: string;
    },
  ): Promise<Order> {
    const order = await this.findOneForCustomer(orderId, customerId);
    if (order.status !== 'awaiting_payment' && order.status !== 'pending') {
      throw new BadRequestException(
        `Order is not awaiting payment (current status: ${order.status})`,
      );
    }
    order.paymentMethod = evidence.paymentMethod;
    order.paymentEvidence = evidence.paymentEvidence;
    order.paymentSubmittedAt = new Date();
    order.status = 'payment_submitted';
    await this.orderRepository.save(order);

    const updated = await this.findOne(order.id);
    void this.notifyAdminsPaymentSubmitted(updated);

    // Attempt automatic verification
    void this.autoVerifyPayment(
      [updated],
      evidence.paymentMethod,
      evidence.paymentEvidence,
      Number(updated.advancePaymentAmount) || 0,
    );

    return updated;
  }

  /** Admin verifies payment -> confirmed */
  async verifyPayment(orderId: string): Promise<Order> {
    return this.updateStatus(orderId, 'confirmed');
  }

  /** Admin rejects payment -> reverts to awaiting_payment */
  async rejectPayment(orderId: string): Promise<Order> {
    const order = await this.findOne(orderId);
    order.status = 'awaiting_payment';
    order.paymentEvidence = null;
    order.paymentSubmittedAt = null;
    await this.orderRepository.save(order);
    return this.findOne(orderId);
  }

  async triggerAutoVerify(orderId: string): Promise<Order> {
    const order = await this.findOne(orderId);

    if (!order.paymentEvidence || !order.paymentMethod) {
      throw new BadRequestException('No payment evidence to verify');
    }
    if (order.status !== 'payment_submitted') {
      throw new BadRequestException(
        `Order is ${order.status}, not payment_submitted`,
      );
    }

    await this.autoVerifyPayment(
      [order],
      order.paymentMethod as 'bank' | 'telebirr',
      order.paymentEvidence,
      Number(order.advancePaymentAmount) || 0,
    );

    return this.findOne(orderId);
  }

  /**
   * Attempt auto-verification via Verify.ET for a batch of orders
   * that share the same payment evidence.
   */
  private async autoVerifyPayment(
    orders: Order[],
    paymentMethod: 'bank' | 'telebirr',
    referenceCode: string,
    totalAdvance: number,
  ): Promise<void> {
    try {
      let extractedTxId = referenceCode;

      try {
        const geminiInput = referenceCode.startsWith('http')
          ? { url: referenceCode, paymentMethod }
          : { text: referenceCode, paymentMethod };
        const ext =
          await this.geminiService.extractTransactionNumber(geminiInput);
        if (ext) {
          extractedTxId = ext;
          this.logger.log(`Extracted TX ID: ${ext} from evidence.`);
        }
      } catch (err) {
        this.logger.warn(`Failed to extract TX ID: ${err}`);
      }

      const result = await this.verifyEtService.verify({
        paymentMethod,
        referenceCode: extractedTxId,
        expectedAmount: totalAdvance,
      });

      // Store verification metadata on all orders in this batch
      for (const order of orders) {
        order.verifyEtRequestId = result.requestId ?? null;
        order.verifyEtStatus = result.outcome;
        order.verifyEtRawResponse =
          (result.rawResponse as Record<string, unknown>) ?? null;
        await this.orderRepository.save(order);
      }

      if (result.outcome === 'verified') {
        // Auto-confirm all orders
        for (const order of orders) {
          await this.updateStatus(order.id, 'confirmed');
        }
        // Logger not defined here directly, using console or can just omit since order is confirmed.
      } else if (result.outcome === 'queued') {
        // Will be resolved by webhook — nothing to do now
      } else if (result.outcome !== 'skipped') {
        // Verification failed — notify admin for manual review
        const first = orders[0];
        const customer = first.customer?.fullName ?? 'Customer';
        const product = first.product?.name ?? 'Product';
        await this.notificationService.create({
          type: 'payment_submitted',
          title: 'Auto-verification failed',
          body: `${customer} · ${product} — ${result.failureReason || result.outcome}. Manual review needed.`,
          orderId: first.id,
          href: '/admin/orders',
        });
      }
    } catch {
      // Silently fail — orders stay in payment_submitted for manual review
    }
  }

  /**
   * Update order status.
   * Restores reserved stock on cancel.
   */
  async updateStatus(
    id: string,
    status: OrderStatus,
    meta?: { cancelledBy?: 'customer' | 'admin' },
  ): Promise<Order> {
    const order = await this.findOne(id);
    const oldStatus = order.status;

    if (oldStatus === status) {
      return order;
    }

    const qty = Math.max(1, order.quantity ?? 1);

    if (status === 'cancelled' && order.stockReserved) {
      await this.productRepository.increment(
        { id: order.productId },
        'stock',
        qty,
      );
      order.stockReserved = false;
    }

    if (status === 'delivered' && !order.stockReserved) {
      const deducted = await this.productRepository
        .createQueryBuilder()
        .update(Product)
        .set({ stock: () => `GREATEST(stock - ${qty}, 0)` })
        .where('id = :id', { id: order.productId })
        .execute();
      if (!deducted.affected) {
        throw new NotFoundException(`Product for order ${id} was not found`);
      }
    }

    if (status === 'confirmed' && !order.paymentVerifiedAt) {
      order.paymentVerifiedAt = new Date();
    }

    order.status = status;
    await this.orderRepository.save(order);
    const updated = await this.findOne(id);

    if (status === 'confirmed') {
      void this.notifyCustomerPaymentVerified(updated);
      void this.notifyAdminsPaymentVerified(updated);
    }

    if (status === 'delivered') {
      void this.notifyCustomerDelivered(updated);
      void this.notifyAdminsOrderDelivered(updated);
    }

    if (status === 'cancelled') {
      void this.notifyAdminsOrderCancelled(
        updated,
        meta?.cancelledBy ?? 'admin',
      );
      if (meta?.cancelledBy === 'customer') {
        void this.notifyCustomerOrderCancelled(updated);
      }
    }

    return updated;
  }

  /** Notify after Mini App checkout (separate from bot-native order replies). */
  private async notifyCustomerShopOrdersPlaced(
    orders: Order[],
    grandTotal: number,
    totalAdvance: number,
    deliveryFee: number,
  ): Promise<void> {
    if (!orders.length) return;
    const first = orders[0];
    const telegramId = first.customer?.telegramId;
    if (telegramId == null) return;

    const name = first.customer?.fullName ?? 'there';
    const lines = orders.map((order) => {
      const qty = order.quantity ?? 1;
      const unit = Number(order.cost) || 0;
      const productName = order.product?.name ?? 'Product';
      return `• ${productName} × ${qty} — ${(unit * qty).toFixed(2)} ETB`;
    });

    const isPickup = first.fulfilmentType === 'pickup';
    const pickupLocName = first.pickupLocation?.name;
    const supportPhone = await this.settingsService.getSupportPhone();

    let text =
      `🛒 Order placed in the shop, ${name}!\n\n` + `${lines.join('\n')}\n\n`;

    if (isPickup) {
      text += `📍 Fulfilment: Store Pickup\n`;
      if (pickupLocName) text += `🏢 Location: ${pickupLocName}\n`;
    } else {
      if (deliveryFee > 0)
        text += `🚚 Delivery fee: ${deliveryFee.toFixed(2)} ETB\n`;
      if (first.deliveryAddress)
        text += `📍 Delivery: ${first.deliveryAddress.trim()}\n`;
    }

    text +=
      `💰 Total: ${grandTotal.toFixed(2)} ETB\n` +
      `💵 50% Advance: ${totalAdvance.toFixed(2)} ETB\n` +
      `⏳ Status: ${first.status}\n\n` +
      `📞 Need help? Contact us: ${supportPhone}\n` +
      `Track status anytime in Products → My orders.`;

    await this.telegramService.sendMessageSafe(String(telegramId), text);
  }

  private async notifyCustomerPaymentVerified(order: Order): Promise<void> {
    const telegramId = order.customer?.telegramId;
    if (telegramId == null) return;

    const name = order.customer?.fullName ?? 'there';
    const productName = order.product?.name ?? 'your product';
    const expected = order.expectedDeliveryDate
      ? new Date(order.expectedDeliveryDate).toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
        })
      : 'Tomorrow';

    const text =
      `✅ Payment verified, ${name}!\n\n` +
      `Your order for ${productName} has been confirmed.\n` +
      `📅 Expected ${order.fulfilmentType === 'pickup' ? 'ready for pickup' : 'delivery'}: ${expected}\n\n` +
      `We're preparing your order! 🌿`;

    await this.telegramService.sendMessageSafe(String(telegramId), text);
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

  private async notifyCustomerOrderCancelled(order: Order): Promise<void> {
    const telegramId = order.customer?.telegramId;
    if (telegramId == null) return;
    const productName = order.product?.name ?? 'your product';
    const name = order.customer?.fullName ?? 'there';
    const text =
      `Order cancelled, ${name}.\n\n` +
      `${productName} × ${order.quantity ?? 1} was cancelled.\n` +
      `If this was a mistake, you can order again from the shop.`;
    await this.telegramService.sendMessageSafe(String(telegramId), text);
  }

  private async notifyAdminsOrderPlaced(order: Order): Promise<void> {
    const customer = order.customer?.fullName ?? 'Customer';
    const product = order.product?.name ?? 'Product';
    const qty = order.quantity ?? 1;
    const total = (Number(order.cost) || 0) * qty;
    await this.notificationService.create({
      type: 'order_placed',
      title: 'New order placed',
      body: `${customer} ordered ${product} × ${qty} · ${total.toFixed(2)} ETB`,
      orderId: order.id,
      href: '/admin/orders',
    });
  }

  private async notifyAdminsPaymentSubmitted(order: Order): Promise<void> {
    const customer = order.customer?.fullName ?? 'Customer';
    const product = order.product?.name ?? 'Product';
    const advance = Number(order.advancePaymentAmount) || 0;
    await this.notificationService.create({
      type: 'payment_submitted',
      title: 'Payment submitted',
      body: `${customer} submitted 50% advance (${advance.toFixed(2)} ETB) for ${product} via ${order.paymentMethod || 'Evidence'}`,
      orderId: order.id,
      href: '/admin/orders',
    });
  }

  private async notifyAdminsPaymentVerified(order: Order): Promise<void> {
    const customer = order.customer?.fullName ?? 'Customer';
    const product = order.product?.name ?? 'Product';
    await this.notificationService.create({
      type: 'payment_verified',
      title: 'Payment verified',
      body: `Payment verified for ${customer} · ${product}`,
      orderId: order.id,
      href: '/admin/orders',
    });
  }

  private async notifyAdminsOrderCancelled(
    order: Order,
    cancelledBy: 'customer' | 'admin',
  ): Promise<void> {
    const customer = order.customer?.fullName ?? 'Customer';
    const product = order.product?.name ?? 'Product';
    const who =
      cancelledBy === 'customer' ? 'Customer cancelled' : 'Order cancelled';
    await this.notificationService.create({
      type: 'order_cancelled',
      title: who,
      body: `${customer} · ${product} × ${order.quantity ?? 1}`,
      orderId: order.id,
      href: '/admin/orders',
    });
  }

  private async notifyAdminsOrderDelivered(order: Order): Promise<void> {
    const customer = order.customer?.fullName ?? 'Customer';
    const product = order.product?.name ?? 'Product';
    await this.notificationService.create({
      type: 'order_delivered',
      title: 'Order delivered',
      body: `${customer} · ${product} × ${order.quantity ?? 1}`,
      orderId: order.id,
      href: '/admin/orders',
    });
  }

  async remove(id: string): Promise<void> {
    const order = await this.orderRepository.findOne({ where: { id } });
    if (!order) {
      throw new NotFoundException(`Order with ID ${id} not found`);
    }
    if (order.status === 'pending' && order.stockReserved) {
      await this.productRepository.increment(
        { id: order.productId },
        'stock',
        Math.max(1, order.quantity ?? 1),
      );
    }
    await this.orderRepository.delete(id);
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
