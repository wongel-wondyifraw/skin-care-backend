import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  forwardRef,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository, MoreThanOrEqual, In } from 'typeorm';
import { Order, OrderStatus, FulfilmentType, PaymentStage } from './order.entity.js';
import { Product } from '../product/product.entity.js';
import { Customer } from '../customer/customer.entity.js';
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
    @InjectRepository(Customer)
    private readonly customerRepository: Repository<Customer>,
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

  /** Line total = unit × qty + delivery fee */
  lineTotal(order: Pick<Order, 'cost' | 'quantity' | 'deliveryFee'>): number {
    const unit = Number(order.cost) || 0;
    const qty = Math.max(1, order.quantity ?? 1);
    const fee = Number(order.deliveryFee) || 0;
    return Math.round((unit * qty + fee) * 100) / 100;
  }

  remainingDue(order: Order): number {
    if (order.paymentStage === 'full') return 0;
    const total = this.lineTotal(order);
    let paid = Number(order.amountPaid) || 0;
    if (
      paid <= 0 &&
      (order.paymentStage === 'partial' ||
        order.paymentVerifiedAt ||
        order.status === 'confirmed' ||
        order.status === 'delivered')
    ) {
      paid = Number(order.advancePaymentAmount) || 0;
    }
    return Math.max(0, Math.round((total - paid) * 100) / 100);
  }

  /**
   * Map Verify.ET amount to partial vs full for a single line.
   * Requires a real bank amount — never credits advance when amount is unknown.
   */
  resolvePaidFromAmount(
    verifiedAmount: number | undefined | null,
    _advance: number,
    total: number,
  ): { paymentStage: PaymentStage; amountPaid: number } {
    const amt = Number(verifiedAmount) || 0;
    const tot = Math.max(0, total);
    if (!(amt > 0)) {
      throw new BadRequestException(
        'Payment amount could not be confirmed. Please try again with a valid receipt.',
      );
    }
    if (tot > 0 && amt >= tot - 1) {
      return { paymentStage: 'full', amountPaid: tot };
    }
    const amountPaid = Math.round(Math.min(amt, tot || amt) * 100) / 100;
    return { paymentStage: 'partial', amountPaid };
  }

  /** Legacy rows: confirmed with no stage → treat as partial. */
  effectivePaymentStage(order: Order): PaymentStage {
    if (order.paymentStage === 'full' || order.paymentStage === 'partial') {
      return order.paymentStage;
    }
    if (
      order.paymentVerifiedAt ||
      order.status === 'confirmed' ||
      order.status === 'delivered'
    ) {
      const rem = this.remainingDue({
        ...order,
        amountPaid:
          Number(order.amountPaid) || Number(order.advancePaymentAmount) || 0,
      } as Order);
      return rem <= 0.01 ? 'full' : 'partial';
    }
    return 'unpaid';
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
    const productIds = items.map((line) => line.productId);
    const products = await this.productRepository.find({
      where: { id: In(productIds) },
    });
    const productById = new Map(products.map((p) => [p.id, p]));

    for (const line of items) {
      const quantity = Math.floor(Number(line.quantity));
      if (!Number.isFinite(quantity) || quantity < 1) {
        throw new BadRequestException('Quantity must be at least 1');
      }

      const product = productById.get(line.productId);
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

    // Spot-only: payment must verify immediately or no order is created
    if (!opts.paymentEvidence?.trim() || !opts.paymentMethod) {
      throw new BadRequestException(
        'Payment method and transaction reference (or receipt screenshot) are required.',
      );
    }

    let verifyResult: Awaited<
      ReturnType<OrderService['verifyEvidence']>
    >['result'];
    let extractedTxId: string;

    try {
      const v = await this.verifyEvidence(
        opts.paymentMethod as 'bank' | 'telebirr',
        opts.paymentEvidence,
        totalAdvance,
        undefined,
        customerId,
      );
      verifyResult = v.result;
      extractedTxId = v.extractedTxId;
      this.assertPaymentAcceptable(verifyResult);
    } catch (err) {
      const reason =
        err instanceof BadRequestException
          ? String(
              (err.getResponse() as { message?: string | string[] })?.message ??
                err.message,
            )
          : err instanceof Error
            ? err.message
            : String(err);
      const msg = Array.isArray(reason) ? reason.join(' ') : reason;
      void this.notifyCustomerVerificationFailed(customerId, msg);
      throw err;
    }

    if (verifyResult.outcome !== 'verified') {
      const msg =
        verifyResult.failureReason ||
        'Payment could not be verified. No order was placed.';
      void this.notifyCustomerVerificationFailed(customerId, msg);
      throw new BadRequestException(msg);
    }

    const cartPaid = this.resolvePaidFromAmount(
      verifyResult.amount,
      totalAdvance,
      grandTotal,
    );

    const created: Order[] = [];
    for (let i = 0; i < productInfos.length; i++) {
      const { product, quantity, unitPrice } = productInfos[i];
      const lineCost = unitPrice * quantity;
      const lineDeliveryFee = i === 0 ? deliveryFee : 0;
      const lineTotal = Math.round((lineCost + lineDeliveryFee) * 100) / 100;
      const lineAdvance =
        subtotal > 0
          ? Math.round((lineCost + lineDeliveryFee) * 0.5 * 100) / 100
          : 0;

      let paymentStage: PaymentStage = cartPaid.paymentStage;
      // Credit the real bank amount across lines (e.g. 60% paid → 40% remaining)
      let amountPaid: number;
      if (cartPaid.paymentStage === 'full') {
        amountPaid = lineTotal;
      } else if (grandTotal > 0) {
        amountPaid =
          Math.round(cartPaid.amountPaid * (lineTotal / grandTotal) * 100) /
          100;
      } else {
        amountPaid = cartPaid.amountPaid;
      }
      // Last line absorbs rounding so sum(amountPaid) ≈ cart paid
      if (
        i === productInfos.length - 1 &&
        cartPaid.paymentStage === 'partial' &&
        grandTotal > 0
      ) {
        const prior = created.reduce(
          (sum, o) => sum + (Number(o.amountPaid) || 0),
          0,
        );
        amountPaid =
          Math.round((cartPaid.amountPaid - prior) * 100) / 100;
        amountPaid = Math.max(0, Math.min(lineTotal, amountPaid));
      }

      const order = await this.create({
        customerId,
        productId: product.id,
        cost: unitPrice,
        quantity,
        deliveryAddress: opts.deliveryAddress ?? null,
        deliveryLat: opts.deliveryLat ?? null,
        deliveryLon: opts.deliveryLon ?? null,
        deliveryDistanceKm: opts.deliveryDistanceKm ?? null,
        status: 'confirmed',
        fulfilmentType,
        pickupLocationId: opts.pickupLocationId ?? null,
        deliveryFee: lineDeliveryFee,
        expectedDeliveryDate: tomorrow,
        advancePaymentAmount: lineAdvance,
        amountPaid,
        paymentStage,
        paymentMethod: opts.paymentMethod ?? null,
        paymentEvidence: extractedTxId,
        paymentSubmittedAt: new Date(),
        paymentVerifiedAt: new Date(),
        balanceVerifiedAt:
          paymentStage === 'full' ? new Date() : null,
        verifyEtRequestId: verifyResult.requestId ?? null,
        verifyEtStatus: verifyResult.outcome,
        verifyEtRawResponse: verifyResult.rawResponse ?? null,
      });

      created.push(order);
    }

    for (const order of created) {
      void this.notifyCustomerPaymentVerified(order);
      void this.notifyAdminsPaymentVerified(order);
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
    amountPaid?: number;
    paymentStage?: PaymentStage;
    paymentMethod?: string | null;
    paymentEvidence?: string | null;
    paymentSubmittedAt?: Date | null;
    paymentVerifiedAt?: Date | null;
    balancePaymentEvidence?: string | null;
    balancePaymentMethod?: string | null;
    balancePaymentSubmittedAt?: Date | null;
    balanceVerifiedAt?: Date | null;
    verifyEtRequestId?: string | null;
    verifyEtStatus?: string | null;
    verifyEtRawResponse?: Record<string, unknown> | null;
    balanceVerifyEtRequestId?: string | null;
    balanceVerifyEtStatus?: string | null;
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
        amountPaid: data.amountPaid ?? 0,
        paymentStage: data.paymentStage ?? 'unpaid',
        paymentMethod: data.paymentMethod ?? null,
        paymentEvidence: data.paymentEvidence ?? null,
        paymentSubmittedAt: data.paymentSubmittedAt ?? null,
        paymentVerifiedAt: data.paymentVerifiedAt ?? null,
        balancePaymentEvidence: data.balancePaymentEvidence ?? null,
        balancePaymentMethod: data.balancePaymentMethod ?? null,
        balancePaymentSubmittedAt: data.balancePaymentSubmittedAt ?? null,
        balanceVerifiedAt: data.balanceVerifiedAt ?? null,
        verifyEtRequestId: data.verifyEtRequestId ?? null,
        verifyEtStatus: data.verifyEtStatus ?? null,
        verifyEtRawResponse: data.verifyEtRawResponse ?? null,
        balanceVerifyEtRequestId: data.balanceVerifyEtRequestId ?? null,
        balanceVerifyEtStatus: data.balanceVerifyEtStatus ?? null,
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

  /** Customer submits payment evidence — advance or remaining balance */
  async submitPaymentEvidence(
    orderId: string,
    customerId: string,
    evidence: {
      paymentMethod: 'bank' | 'telebirr';
      paymentEvidence: string;
    },
  ): Promise<Order> {
    const order = await this.findOneForCustomer(orderId, customerId);
    const stage = this.effectivePaymentStage(order);
    const remaining = this.remainingDue({
      ...order,
      amountPaid:
        Number(order.amountPaid) ||
        (stage === 'partial' || stage === 'full'
          ? Number(order.advancePaymentAmount) || 0
          : 0),
      paymentStage: stage,
    } as Order);

    const isBalancePay =
      (order.status === 'confirmed' || order.status === 'delivered') &&
      stage === 'partial' &&
      remaining > 0.01;

    if (isBalancePay) {
      return this.submitBalancePayment(order, evidence, remaining);
    }

    if (order.status !== 'awaiting_payment' && order.status !== 'pending') {
      throw new BadRequestException(
        `Order is not awaiting payment (current status: ${order.status})`,
      );
    }

    const advance = Number(order.advancePaymentAmount) || 0;
    const total = this.lineTotal(order);

    // Recompute advance from line total so delivery fee is never dropped
    const expectedAdvance =
      advance > 0 ? advance : Math.round(total * 0.5 * 100) / 100;

    let v: Awaited<ReturnType<OrderService['verifyEvidence']>>;
    try {
      v = await this.verifyEvidence(
        evidence.paymentMethod,
        evidence.paymentEvidence,
        expectedAdvance,
        order.id,
        customerId,
      );
      this.assertPaymentAcceptable(v.result);
    } catch (err) {
      const reason =
        err instanceof BadRequestException
          ? String(
              (err.getResponse() as { message?: string | string[] })?.message ??
                err.message,
            )
          : err instanceof Error
            ? err.message
            : String(err);
      const msg = Array.isArray(reason) ? reason.join(' ') : reason;
      void this.notifyCustomerVerificationFailed(customerId, msg);
      throw err;
    }

    order.paymentMethod = evidence.paymentMethod;
    order.paymentEvidence = v.extractedTxId;
    order.paymentSubmittedAt = new Date();
    order.verifyEtRequestId = v.result.requestId ?? null;
    order.verifyEtStatus = v.result.outcome;
    order.verifyEtRawResponse =
      (v.result.rawResponse as Record<string, unknown>) ?? null;

    const paid = this.resolvePaidFromAmount(
      v.result.amount,
      expectedAdvance,
      total,
    );
    order.status = 'confirmed';
    order.paymentVerifiedAt = new Date();
    order.paymentStage = paid.paymentStage;
    order.amountPaid = paid.amountPaid;
    if (paid.paymentStage === 'full') {
      order.balanceVerifiedAt = new Date();
    }

    await this.orderRepository.save(order);

    const updated = await this.findOne(order.id);
    void this.notifyCustomerPaymentVerified(updated);
    void this.notifyAdminsPaymentVerified(updated);
    return updated;
  }

  private async submitBalancePayment(
    order: Order,
    evidence: {
      paymentMethod: 'bank' | 'telebirr';
      paymentEvidence: string;
    },
    remaining: number,
  ): Promise<Order> {
    const total = this.lineTotal(order);
    let v: Awaited<ReturnType<OrderService['verifyEvidence']>>;
    try {
      v = await this.verifyEvidence(
        evidence.paymentMethod,
        evidence.paymentEvidence,
        remaining,
        order.id,
        order.customerId,
      );
      this.assertPaymentAcceptable(v.result);
    } catch (err) {
      const reason =
        err instanceof BadRequestException
          ? String(
              (err.getResponse() as { message?: string | string[] })?.message ??
                err.message,
            )
          : err instanceof Error
            ? err.message
            : String(err);
      const msg = Array.isArray(reason) ? reason.join(' ') : reason;
      void this.notifyCustomerVerificationFailed(order.customerId, msg);
      throw err;
    }

    order.balancePaymentMethod = evidence.paymentMethod;
    order.balancePaymentEvidence = v.extractedTxId;
    order.balancePaymentSubmittedAt = new Date();
    order.balanceVerifyEtRequestId = v.result.requestId ?? null;
    order.balanceVerifyEtStatus = v.result.outcome;

    order.paymentStage = 'full';
    order.amountPaid = total;
    order.balanceVerifiedAt = new Date();
    await this.orderRepository.save(order);
    const updated = await this.findOne(order.id);
    void this.notifyCustomerBalanceVerified(updated);
    void this.notifyAdminsBalanceVerified(updated);
    return updated;
  }

  /** Admin verifies advance payment → confirmed + partial (or full if known) */
  async verifyPayment(orderId: string): Promise<Order> {
    const order = await this.findOne(orderId);
    if (order.status !== 'payment_submitted' && order.status !== 'awaiting_payment') {
      throw new BadRequestException(
        `Order is ${order.status}; only submitted payments can be verified`,
      );
    }
    const advance = Number(order.advancePaymentAmount) || 0;
    const total = this.lineTotal(order);
    const rawAmt = Number(
      (order.verifyEtRawResponse as { amount?: number } | null)?.amount,
    );
    // Prefer amount from last Verify.ET payload if present
    let verifiedAmount: number | undefined;
    const data = order.verifyEtRawResponse;
    if (data && typeof data === 'object') {
      const nested = (data as { data?: unknown }).data;
      const row = Array.isArray(nested)
        ? (nested[0] as Record<string, unknown> | undefined)
        : (nested as Record<string, unknown> | undefined);
      const fromNested = Number(row?.amount);
      const fromTop = Number((data as { amount?: number }).amount);
      if (fromNested > 0) verifiedAmount = fromNested;
      else if (fromTop > 0) verifiedAmount = fromTop;
      else if (rawAmt > 0) verifiedAmount = rawAmt;
    }
    const paid = this.resolvePaidFromAmount(verifiedAmount, advance, total);
    order.paymentStage = paid.paymentStage;
    order.amountPaid = paid.amountPaid;
    if (paid.paymentStage === 'full') {
      order.balanceVerifiedAt = new Date();
    }
    await this.orderRepository.save(order);
    return this.updateStatus(orderId, 'confirmed');
  }

  /** Admin marks remaining balance as collected (half → fully paid). */
  async markFullyPaid(orderId: string): Promise<Order> {
    const order = await this.findOne(orderId);
    const stage = this.effectivePaymentStage(order);
    if (stage === 'full') {
      return order;
    }
    if (stage !== 'partial' && order.status !== 'confirmed' && order.status !== 'delivered') {
      throw new BadRequestException(
        'Only half-payment verified orders can be marked fully paid',
      );
    }
    const total = this.lineTotal(order);
    order.paymentStage = 'full';
    order.amountPaid = total;
    order.balanceVerifiedAt = new Date();
    if (!order.paymentVerifiedAt) {
      order.paymentVerifiedAt = new Date();
    }
    if (order.status === 'awaiting_payment' || order.status === 'payment_submitted' || order.status === 'pending') {
      order.status = 'confirmed';
    }
    await this.orderRepository.save(order);
    const updated = await this.findOne(orderId);
    void this.notifyCustomerBalanceVerified(updated);
    void this.notifyAdminsBalanceVerified(updated);
    return updated;
  }

  /** Admin rejects payment -> reverts to awaiting_payment */
  async rejectPayment(orderId: string): Promise<Order> {
    const order = await this.findOne(orderId);
    order.status = 'awaiting_payment';
    order.paymentEvidence = null;
    order.paymentSubmittedAt = null;
    order.paymentStage = 'unpaid';
    order.amountPaid = 0;
    order.verifyEtStatus = null;
    order.verifyEtRequestId = null;
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

    const advance = Number(order.advancePaymentAmount) || 0;
    const total = this.lineTotal(order);
    const v = await this.verifyEvidence(
      order.paymentMethod as 'bank' | 'telebirr',
      order.paymentEvidence,
      advance,
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
      const paid = this.resolvePaidFromAmount(result.amount, advance, total);
      order.paymentStage = paid.paymentStage;
      order.amountPaid = paid.amountPaid;
      if (paid.paymentStage === 'full') {
        order.balanceVerifiedAt = new Date();
      }
      await this.orderRepository.save(order);
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
   * - Screenshot URL: Gemini detects bank + extracts TX; rejects method mismatch.
   * Only `verified` outcomes are acceptable for placing/confirming payment.
   */
  async verifyEvidence(
    paymentMethod: 'bank' | 'telebirr',
    referenceCode: string,
    expectedAmount: number,
    excludeOrderId?: string,
    _customerIdForWarn?: string,
  ) {
    const raw = (referenceCode || '').trim();
    if (!raw) {
      throw new BadRequestException(
        'Enter your transaction reference or upload a receipt screenshot.',
      );
    }

    if (!(expectedAmount > 0)) {
      throw new BadRequestException(
        'Expected payment amount is invalid. Please refresh and try again.',
      );
    }

    let extractedTxId: string;

    if (/^https?:\/\//i.test(raw)) {
      let receipt: Awaited<
        ReturnType<GeminiService['extractReceiptPayment']>
      >;
      try {
        receipt = await this.geminiService.extractReceiptPayment({ url: raw });
      } catch (err) {
        this.logger.warn(`Failed to extract receipt from screenshot: ${err}`);
        throw new BadRequestException(
          'Could not read the receipt screenshot. Please paste the transaction number instead. No order was placed.',
        );
      }

      if (!receipt.transactionNumber) {
        throw new BadRequestException(
          'Could not read a transaction number from the screenshot. Please paste the transaction ID instead. No order was placed.',
        );
      }

      const detectedMethod =
        receipt.bank === 'cbe'
          ? 'bank'
          : receipt.bank === 'telebirr'
            ? 'telebirr'
            : null;

      if (detectedMethod && detectedMethod !== paymentMethod) {
        throw new BadRequestException(
          paymentMethod === 'telebirr'
            ? 'This looks like a CBE receipt. Select CBE Bank, or upload a Telebirr screenshot. No order was placed.'
            : 'This looks like a Telebirr receipt. Select Telebirr, or upload a CBE screenshot. No order was placed.',
        );
      }

      if (
        !detectedMethod &&
        /^FT[A-Z0-9]+$/i.test(receipt.transactionNumber) &&
        paymentMethod === 'telebirr'
      ) {
        throw new BadRequestException(
          'This transaction looks like a CBE FT reference, but you selected Telebirr. Select CBE Bank or upload a Telebirr receipt. No order was placed.',
        );
      }

      extractedTxId = this.normalizeTxId(
        receipt.transactionNumber,
        paymentMethod,
      );
      this.logger.log(
        `Extracted TX ID: ${extractedTxId} (detected bank=${receipt.bank}, confidence=${receipt.confidence})`,
      );
    } else {
      extractedTxId = this.normalizeTxId(raw, paymentMethod);
      if (extractedTxId.length < 6) {
        throw new BadRequestException(
          'Transaction reference looks too short. Paste the full FT / Telebirr reference.',
        );
      }
      if (/^FT/i.test(extractedTxId) && paymentMethod === 'telebirr') {
        throw new BadRequestException(
          'This looks like a CBE FT reference, but you selected Telebirr. Select CBE Bank instead. No order was placed.',
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
      .andWhere(
        '(LOWER(TRIM(order.paymentEvidence)) = LOWER(:tx) OR LOWER(TRIM(order.balancePaymentEvidence)) = LOWER(:tx))',
        { tx: normalized },
      );

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

  /** Reject anything except immediate verified — no pending placement. */
  private assertPaymentAcceptable(result: {
    outcome: string;
    failureReason?: string;
    requestId?: string;
  }): void {
    if (result.outcome === 'verified') return;

    const friendly: Record<string, string> = {
      duplicate:
        'This transaction was already used for another order. Each payment can only confirm one order. No order was placed.',
      queued:
        'Bank verification is still processing. Please wait a moment and try again with the same receipt. No order was placed.',
      amount_mismatch:
        result.failureReason ||
        'The amount paid is less than the required advance (including delivery). No order was placed.',
      stale_payment:
        result.failureReason ||
        'This payment is older than 48 hours. Please make a new transfer for this order and submit that receipt. No order was placed.',
      receiver_mismatch:
        'Payment did not reach our account. Check you transferred to the correct CBE/Telebirr details. No order was placed.',
    };
    throw new BadRequestException(
      friendly[result.outcome] ||
        result.failureReason ||
        `Payment could not be verified (${result.outcome}). No order was placed.`,
    );
  }

  private async notifyCustomerVerificationFailed(
    customerId: string,
    reason: string,
  ): Promise<void> {
    try {
      const customer = await this.customerRepository.findOne({
        where: { id: customerId },
      });
      const telegramId = customer?.telegramId;
      if (telegramId == null) return;

      const clean = reason.replace(/\s+/g, ' ').trim().slice(0, 500);
      const text =
        `⚠️ *Payment verification failed*\n\n` +
        `📝 Reason: ${clean}\n` +
        `❌ No order was placed\n\n` +
        `Please pay within *48 hours* and try again with a clear receipt (natural light) or paste your transaction number.`;

      await this.telegramService.sendMessageSafe(String(telegramId), text, {
        parse_mode: 'Markdown',
      });
    } catch (err) {
      this.logger.warn(`Failed to send verification warning: ${err}`);
    }
  }

  private paymentMethodEmojiLabel(method?: string | null): string {
    if (method === 'telebirr') return '📱 Telebirr';
    if (method === 'bank') return '🏦 CBE';
    return '💳 —';
  }

  /** Rich half/full payment copy for Telegram (checkout + bot). */
  formatPaymentVerifiedMessage(order: Order): string {
    const product = order.product?.name ?? 'Product';
    const qty = order.quantity ?? 1;
    const expected = order.expectedDeliveryDate
      ? new Date(order.expectedDeliveryDate).toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
        })
      : 'Tomorrow';
    const location =
      order.fulfilmentType === 'pickup'
        ? `🏪 ${order.pickupLocation?.name || 'Store pickup'}`
        : `📍 ${order.deliveryAddress?.trim() || 'Delivery'}`;
    const paid =
      Number(order.amountPaid) || Number(order.advancePaymentAmount) || 0;
    const total = this.lineTotal(order);
    const remaining = Math.max(0, Math.round((total - paid) * 100) / 100);
    const isFull = order.paymentStage === 'full' || remaining <= 0.01;
    const paidPct =
      total > 0 ? Math.min(100, Math.round((paid / total) * 100)) : 0;
    const remPct = Math.max(0, 100 - paidPct);
    const method = this.paymentMethodEmojiLabel(
      order.balancePaymentMethod || order.paymentMethod,
    );

    if (isFull) {
      return (
        `✅ *Full payment verified*\n\n` +
        `🛍 ${product} × ${qty}\n` +
        `💰 Order total: *${total.toFixed(2)} ETB*\n` +
        `💵 Paid: *${paid.toFixed(2)} ETB* (${paidPct}%)\n` +
        `✨ Outstanding: *0.00 ETB*\n` +
        `${method}\n` +
        `📅 Expected: *${expected}*\n` +
        `${location}\n\n` +
        `Your order is confirmed and fully paid. Thank you! 🌿`
      );
    }

    return (
      `✅ *Half payment verified*\n\n` +
      `🛍 ${product} × ${qty}\n` +
      `💰 Order total: *${total.toFixed(2)} ETB*\n` +
      `💵 Paid now: *${paid.toFixed(2)} ETB* (${paidPct}%)\n` +
      `⏳ Outstanding: *${remaining.toFixed(2)} ETB* (${remPct}%)\n` +
      `${method}\n` +
      `📅 Expected: *${expected}*\n` +
      `${location}\n\n` +
      `Pay the remaining from *My Orders* when ready.`
    );
  }

  formatBalanceVerifiedMessage(order: Order, balancePaid?: number): string {
    const product = order.product?.name ?? 'Order';
    const qty = order.quantity ?? 1;
    const total = this.lineTotal(order);
    const paid = Number(order.amountPaid) || total;
    const advance = Number(order.advancePaymentAmount) || 0;
    const balance =
      balancePaid != null && balancePaid > 0
        ? balancePaid
        : Math.max(0, Math.round((total - advance) * 100) / 100);
    const method = this.paymentMethodEmojiLabel(
      order.balancePaymentMethod || order.paymentMethod,
    );

    return (
      `✅ *Remaining payment verified*\n\n` +
      `🛍 ${product} × ${qty}\n` +
      `💵 Balance paid: *${balance.toFixed(2)} ETB*\n` +
      `✨ Status: *Fully paid*\n` +
      `💰 Order total: *${total.toFixed(2)} ETB*\n` +
      `💵 Total collected: *${paid.toFixed(2)} ETB*\n` +
      `${method}\n\n` +
      `No outstanding balance. See you at delivery/pickup! 🌿`
    );
  }

  /**
   * After checkout returns queued: keep polling Verify.ET in the background
   * so confirmation still happens if the webhook is delayed or missing.
   */
  scheduleFinishQueuedVerification(
    orders: Order[],
    expectedAmount: number,
    orderTotal?: number,
  ): void {
    void this.finishQueuedVerification(orders, expectedAmount, orderTotal);
  }

  private async finishQueuedVerification(
    orders: Order[],
    expectedAmount: number,
    orderTotal?: number,
  ): Promise<void> {
    const requestId = orders[0]?.verifyEtRequestId;
    if (!requestId) return;

    try {
      const result = await this.verifyEtService.pollUntilDone(
        requestId,
        expectedAmount,
      );

      const cartTotal =
        orderTotal ??
        orders.reduce((sum, o) => sum + this.lineTotal(o), 0);

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
          const advance = Number(order.advancePaymentAmount) || 0;
          const lineTot = this.lineTotal(order);
          // Scale share of cart payment onto this line
          const paid = this.resolvePaidFromAmount(
            result.amount,
            expectedAmount,
            cartTotal,
          );
          if (paid.paymentStage === 'full') {
            order.paymentStage = 'full';
            order.amountPaid = lineTot;
            order.balanceVerifiedAt = new Date();
          } else {
            order.paymentStage = 'partial';
            order.amountPaid = advance;
          }
          await this.orderRepository.save(order);
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

  private async finishQueuedBalanceVerification(
    orderStub: Order,
    expectedRemaining: number,
    lineTotal: number,
  ): Promise<void> {
    const requestId = orderStub.balanceVerifyEtRequestId;
    if (!requestId) return;
    try {
      const result = await this.verifyEtService.pollUntilDone(
        requestId,
        expectedRemaining,
      );
      const order = await this.findOne(orderStub.id);
      order.balanceVerifyEtStatus = result.outcome;
      if (result.outcome === 'verified') {
        order.paymentStage = 'full';
        order.amountPaid = lineTotal;
        order.balanceVerifiedAt = new Date();
        await this.orderRepository.save(order);
        const updated = await this.findOne(order.id);
        void this.notifyCustomerBalanceVerified(updated);
        void this.notifyAdminsBalanceVerified(updated);
      } else {
        await this.orderRepository.save(order);
        if (result.outcome !== 'queued') {
          await this.notificationService.create({
            type: 'payment_submitted',
            title: 'Balance verification failed',
            body: `${order.customer?.fullName ?? 'Customer'} · ${order.product?.name ?? 'Product'} — ${result.failureReason || result.outcome}.`,
            orderId: order.id,
            href: '/admin/orders',
          });
        }
      }
    } catch (err) {
      this.logger.warn(
        `Background balance verification for ${requestId} ended with error: ${err}`,
      );
    }
  }

  /**
   * Apply verified payment stage from webhook / shared requestId.
   */
  async applyVerifiedPaymentFromResult(
    orderId: string,
    result: { outcome: string; amount?: number },
    cartAdvance: number,
    cartTotal: number,
  ): Promise<void> {
    const order = await this.findOne(orderId);
    if (order.status === 'confirmed' || order.status === 'cancelled') {
      return;
    }
    if (
      result.outcome !== 'verified' ||
      (order.status !== 'payment_submitted' &&
        order.status !== 'awaiting_payment')
    ) {
      return;
    }
    const advance = Number(order.advancePaymentAmount) || 0;
    const lineTot = this.lineTotal(order);
    const paid = this.resolvePaidFromAmount(
      result.amount,
      cartAdvance,
      cartTotal,
    );
    if (paid.paymentStage === 'full') {
      order.paymentStage = 'full';
      order.amountPaid = lineTot;
      order.balanceVerifiedAt = new Date();
    } else {
      order.paymentStage = 'partial';
      order.amountPaid = advance;
    }
    await this.orderRepository.save(order);
    await this.updateStatus(order.id, 'confirmed');
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

    if (status === 'confirmed') {
      const stage = order.paymentStage;
      if (!stage || stage === 'unpaid') {
        const advance = Number(order.advancePaymentAmount) || 0;
        const total = this.lineTotal(order);
        order.paymentStage = 'partial';
        if (!(Number(order.amountPaid) > 0)) {
          order.amountPaid = advance || total * 0.5;
        }
      }
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

    await this.telegramService.sendMessageSafe(
      String(telegramId),
      this.formatPaymentVerifiedMessage(order),
      { parse_mode: 'Markdown' },
    );
  }

  private async notifyCustomerBalanceVerified(order: Order): Promise<void> {
    const telegramId = order.customer?.telegramId;
    if (telegramId == null) return;

    await this.telegramService.sendMessageSafe(
      String(telegramId),
      this.formatBalanceVerifiedMessage(order),
      { parse_mode: 'Markdown' },
    );
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
    const stage = order.paymentStage === 'full' ? 'Fully paid' : 'Half payment verified';
    const method =
      order.paymentMethod === 'telebirr'
        ? 'Telebirr'
        : order.paymentMethod === 'bank'
          ? 'CBE'
          : order.paymentMethod || '—';
    await this.notificationService.create({
      type: 'payment_verified',
      title: stage,
      body: `${customer} · ${product} via ${method}`,
      orderId: order.id,
      href: '/admin/orders',
    });
  }

  private async notifyAdminsBalanceVerified(order: Order): Promise<void> {
    const customer = order.customer?.fullName ?? 'Customer';
    const product = order.product?.name ?? 'Product';
    const method =
      order.balancePaymentMethod === 'telebirr'
        ? 'Telebirr'
        : order.balancePaymentMethod === 'bank'
          ? 'CBE'
          : 'admin';
    await this.notificationService.create({
      type: 'payment_verified',
      title: 'Fully paid',
      body: `${customer} · ${product} remaining via ${method}`,
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
