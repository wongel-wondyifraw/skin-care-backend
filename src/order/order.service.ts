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

    // Verify payment: fast path = verified now; else queue + webhook/background
    let verifyResult: Awaited<
      ReturnType<OrderService['verifyEvidence']>
    >['result'] | null = null;
    let extractedTxId: string | null = null;

    if (opts.paymentEvidence || opts.paymentMethod) {
      if (!opts.paymentEvidence?.trim() || !opts.paymentMethod) {
        throw new BadRequestException(
          'Payment method and transaction reference (or receipt screenshot) are required.',
        );
      }

      const v = await this.verifyEvidence(
        opts.paymentMethod as 'bank' | 'telebirr',
        opts.paymentEvidence,
        totalAdvance,
      );
      verifyResult = v.result;
      extractedTxId = v.extractedTxId;
      this.assertPaymentAcceptable(verifyResult);
    }

    const initialStatus: OrderStatus =
      verifyResult?.outcome === 'verified'
        ? 'confirmed'
        : verifyResult?.outcome === 'queued'
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
        paymentEvidence: extractedTxId ?? opts.paymentEvidence ?? null,
        paymentSubmittedAt: verifyResult ? new Date() : null,
        paymentVerifiedAt:
          verifyResult?.outcome === 'verified' ? new Date() : null,
        verifyEtRequestId: verifyResult?.requestId ?? null,
        verifyEtStatus: verifyResult?.outcome ?? null,
        verifyEtRawResponse: verifyResult?.rawResponse ?? null,
      });

      created.push(order);
    }

    if (initialStatus === 'confirmed') {
      for (const order of created) {
        void this.notifyCustomerPaymentVerified(order);
        void this.notifyAdminsPaymentVerified(order);
      }
    } else if (initialStatus === 'payment_submitted') {
      void this.notifyAdminsPaymentSubmitted(created[0]);
      // Webhook + background poll will confirm (or fail) without blocking checkout
      void this.finishQueuedVerification(created, totalAdvance);
    } else {
      void this.notifyCustomerShopOrdersPlaced(
        created,
        grandTotal,
        totalAdvance,
        deliveryFee,
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
    paymentVerifiedAt?: Date | null;
    verifyEtRequestId?: string | null;
    verifyEtStatus?: string | null;
    verifyEtRawResponse?: Record<string, unknown> | null;
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
        paymentVerifiedAt: data.paymentVerifiedAt ?? null,
        verifyEtRequestId: data.verifyEtRequestId ?? null,
        verifyEtStatus: data.verifyEtStatus ?? null,
        verifyEtRawResponse: data.verifyEtRawResponse ?? null,
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

  /** Customer submits payment evidence — confirms only when Verify.ET verifies */
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
    const v = await this.verifyEvidence(
      evidence.paymentMethod,
      evidence.paymentEvidence,
      Number(order.advancePaymentAmount) || 0,
      order.id,
    );

    this.assertPaymentAcceptable(v.result);

    order.paymentMethod = evidence.paymentMethod;
    order.paymentEvidence = v.extractedTxId;
    order.paymentSubmittedAt = new Date();
    order.verifyEtRequestId = v.result.requestId ?? null;
    order.verifyEtStatus = v.result.outcome;
    order.verifyEtRawResponse =
      (v.result.rawResponse as Record<string, unknown>) ?? null;

    if (v.result.outcome === 'verified') {
      order.status = 'confirmed';
      order.paymentVerifiedAt = new Date();
    } else {
      order.status = 'payment_submitted';
    }

    await this.orderRepository.save(order);

    const updated = await this.findOne(order.id);

    if (updated.status === 'confirmed') {
      void this.notifyCustomerPaymentVerified(updated);
      void this.notifyAdminsPaymentVerified(updated);
    } else {
      void this.notifyAdminsPaymentSubmitted(updated);
      void this.finishQueuedVerification(
        [updated],
        Number(updated.advancePaymentAmount) || 0,
      );
    }

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
    if (
      order.status !== 'payment_submitted' &&
      order.status !== 'awaiting_payment'
    ) {
      throw new BadRequestException(
        `Order is ${order.status}; only payment_submitted / awaiting_payment can be re-verified`,
      );
    }

    const v = await this.verifyEvidence(
      order.paymentMethod as 'bank' | 'telebirr',
      order.paymentEvidence,
      Number(order.advancePaymentAmount) || 0,
      order.id,
    );
    const result = v.result;

    order.paymentEvidence = v.extractedTxId;
    order.verifyEtRequestId = result.requestId ?? null;
    order.verifyEtStatus = result.outcome;
    order.verifyEtRawResponse =
      (result.rawResponse as Record<string, unknown>) ?? null;
    await this.orderRepository.save(order);

    if (result.outcome === 'verified') {
      await this.updateStatus(order.id, 'confirmed');
    } else {
      const customer = order.customer?.fullName ?? 'Customer';
      const product = order.product?.name ?? 'Product';
      await this.notificationService.create({
        type: 'payment_submitted',
        title: 'Re-verification failed',
        body: `${customer} · ${product} — ${result.failureReason || result.outcome}.`,
        orderId: order.id,
        href: '/admin/orders',
      });
    }

    return this.findOne(orderId);
  }

  /**
   * Normalize evidence then call Verify.ET.
   * - Pasted TX text: cleaned locally (no Gemini).
   * - Screenshot URL: Gemini MUST extract a TX id before verify.
   */
  async verifyEvidence(
    paymentMethod: 'bank' | 'telebirr',
    referenceCode: string,
    expectedAmount: number,
    excludeOrderId?: string,
  ) {
    const raw = (referenceCode || '').trim();
    if (!raw) {
      throw new BadRequestException(
        'Enter your transaction reference or upload a receipt screenshot.',
      );
    }

    let extractedTxId: string;

    if (/^https?:\/\//i.test(raw)) {
      let ext: string | null = null;
      try {
        ext = await this.geminiService.extractTransactionNumber({
          url: raw,
          paymentMethod,
        });
      } catch (err) {
        this.logger.warn(`Failed to extract TX ID from screenshot: ${err}`);
      }
      if (!ext) {
        throw new BadRequestException(
          'Could not read a transaction number from the screenshot. Please paste the transaction ID instead.',
        );
      }
      extractedTxId = this.normalizeTxId(ext, paymentMethod);
      this.logger.log(`Extracted TX ID: ${extractedTxId} from screenshot.`);
    } else {
      extractedTxId = this.normalizeTxId(raw, paymentMethod);
      if (extractedTxId.length < 6) {
        throw new BadRequestException(
          'Transaction reference looks too short. Paste the full FT / Telebirr reference.',
        );
      }
    }

    await this.assertTxNotAlreadyUsed(extractedTxId, excludeOrderId);

    const result = await this.verifyEtService.verify({
      paymentMethod,
      referenceCode: extractedTxId,
      expectedAmount,
    });

    return { result, extractedTxId };
  }

  /**
   * Block replay of the same bank/Telebirr reference across orders.
   * Defense in depth alongside Verify.ET confirmationHistory.
   */
  private async assertTxNotAlreadyUsed(
    txId: string,
    excludeOrderId?: string,
  ): Promise<void> {
    const normalized = txId.trim();
    if (!normalized) return;

    const qb = this.orderRepository
      .createQueryBuilder('order')
      .where('order.status != :cancelled', { cancelled: 'cancelled' })
      .andWhere('LOWER(TRIM(order.paymentEvidence)) = LOWER(:tx)', {
        tx: normalized,
      });

    if (excludeOrderId) {
      qb.andWhere('order.id != :excludeId', { excludeId: excludeOrderId });
    }

    const existing = await qb.getOne();
    if (existing) {
      throw new BadRequestException(
        'This transaction reference was already used for another order. Each payment can only confirm one order.',
      );
    }
  }

  /** Reject hard failures; allow verified (done) or queued (webhook/background). */
  private assertPaymentAcceptable(result: {
    outcome: string;
    failureReason?: string;
    requestId?: string;
  }): void {
    if (result.outcome === 'verified') return;
    if (result.outcome === 'queued' && result.requestId) return;

    const friendly: Record<string, string> = {
      duplicate:
        'This transaction was already used for another order. Each payment can only confirm one order.',
      queued:
        'Payment verification is still pending. Please try again in a moment.',
    };
    throw new BadRequestException(
      friendly[result.outcome] ||
        result.failureReason ||
        `Payment could not be verified (${result.outcome}). Check the transaction ID and try again.`,
    );
  }

  /**
   * After checkout returns queued: keep polling Verify.ET in the background
   * so confirmation still happens if the webhook is delayed or missing.
   */
  scheduleFinishQueuedVerification(
    orders: Order[],
    expectedAmount: number,
  ): void {
    void this.finishQueuedVerification(orders, expectedAmount);
  }

  private async finishQueuedVerification(
    orders: Order[],
    expectedAmount: number,
  ): Promise<void> {
    const requestId = orders[0]?.verifyEtRequestId;
    if (!requestId) return;

    try {
      const result = await this.verifyEtService.pollUntilDone(
        requestId,
        expectedAmount,
      );

      for (const stub of orders) {
        const order = await this.findOne(stub.id);
        if (order.status === 'confirmed' || order.status === 'cancelled') {
          continue;
        }

        order.verifyEtStatus = result.outcome;
        order.verifyEtRawResponse =
          (result.rawResponse as Record<string, unknown>) ?? null;
        await this.orderRepository.save(order);

        if (
          result.outcome === 'verified' &&
          (order.status === 'payment_submitted' ||
            order.status === 'awaiting_payment')
        ) {
          await this.updateStatus(order.id, 'confirmed');
        } else if (result.outcome !== 'queued') {
          await this.notificationService.create({
            type: 'payment_submitted',
            title: 'Auto-verification failed',
            body: `${order.customer?.fullName ?? 'Customer'} · ${order.product?.name ?? 'Product'} — ${result.failureReason || result.outcome}.`,
            orderId: order.id,
            href: '/admin/orders',
          });
        }
      }
    } catch (err) {
      this.logger.warn(
        `Background verification for ${requestId} ended with error: ${err}`,
      );
    }
  }

  private normalizeTxId(
    raw: string,
    paymentMethod: 'bank' | 'telebirr',
  ): string {
    let s = raw.trim().replace(/\s+/g, '');
    s = s.replace(/^(txn|tx|ref|reference|transaction)[:#=-]*/i, '');
    // Prefer FT… token for bank transfers when embedded in SMS-like text
    if (paymentMethod === 'bank') {
      const ft = s.match(/FT[A-Z0-9]+/i);
      if (ft) return ft[0].toUpperCase();
    }
    return s;
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
    _grandTotal: number,
    totalAdvance: number,
    _deliveryFee: number,
  ): Promise<void> {
    if (!orders.length) return;
    const first = orders[0];
    const telegramId = first.customer?.telegramId;
    if (telegramId == null) return;

    const expected = first.expectedDeliveryDate
      ? new Date(first.expectedDeliveryDate).toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
        })
      : 'Tomorrow';
    const location =
      first.fulfilmentType === 'pickup'
        ? first.pickupLocation?.name || 'Store pickup'
        : first.deliveryAddress?.trim() || 'Delivery';

    const text =
      `✅ *Order placed*\n\n` +
      `💵 Prepayment: *${totalAdvance.toFixed(2)} ETB*\n` +
      `📅 Expected: *${expected}*\n` +
      `📍 ${location}`;

    await this.telegramService.sendMessageSafe(String(telegramId), text, {
      parse_mode: 'Markdown',
    });
  }

  private async notifyCustomerPaymentVerified(order: Order): Promise<void> {
    const telegramId = order.customer?.telegramId;
    if (telegramId == null) return;

    const expected = order.expectedDeliveryDate
      ? new Date(order.expectedDeliveryDate).toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
        })
      : 'Tomorrow';
    const location =
      order.fulfilmentType === 'pickup'
        ? order.pickupLocation?.name || 'Store pickup'
        : order.deliveryAddress?.trim() || 'Delivery';
    const advance = Number(order.advancePaymentAmount) || 0;

    const text =
      `✅ *Payment confirmed*\n\n` +
      `💵 Prepayment: *${advance.toFixed(2)} ETB*\n` +
      `📅 Expected: *${expected}*\n` +
      `📍 ${location}`;

    await this.telegramService.sendMessageSafe(String(telegramId), text, {
      parse_mode: 'Markdown',
    });
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
