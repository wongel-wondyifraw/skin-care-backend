import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { CartService } from './cart.service.js';
import { OrderService } from '../order/order.service.js';
import { TelegramService } from '../telegram/telegram.service.js';
import { Product } from '../product/product.entity.js';
import { Cart } from './cart.entity.js';
import { effectiveUnitPrice } from '../product/product-pricing.js';

@Injectable()
export class CartReminderService {
  private readonly logger = new Logger(CartReminderService.name);

  constructor(
    private readonly cartService: CartService,
    @Inject(forwardRef(() => OrderService))
    private readonly orderService: OrderService,
    @Inject(forwardRef(() => TelegramService))
    private readonly telegramService: TelegramService,
    @InjectRepository(Product)
    private readonly productRepository: Repository<Product>,
    private readonly configService: ConfigService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async checkAbandonedCarts(): Promise<void> {
    this.logger.log('Running abandoned cart check...');
    try {
      const abandoned = await this.cartService.findAbandonedCarts();
      for (const cart of abandoned) {
        if (!cart.customer?.telegramId) continue;

        // Check if customer placed an order since the cart was updated
        const recentOrders = await this.orderService.findRecentByCustomer(
          cart.customerId,
          cart.updatedAt,
        );
        if (recentOrders.length > 0) {
          // Customer ordered already, mark reminded to prevent stale notifications
          await this.cartService.markReminded(cart.id);
          continue;
        }

        await this.sendCartReminder(cart);
        await this.cartService.markReminded(cart.id);
      }
    } catch (err) {
      this.logger.error('Error during abandoned cart check', err);
    }
  }

  private async sendCartReminder(cart: Cart): Promise<void> {
    const productIds = (cart.items || []).map((i) => i.productId);
    if (!productIds.length) return;

    const products = await this.productRepository.find({
      where: { id: In(productIds) },
    });
    const productMap = new Map(products.map((p) => [p.id, p]));

    let total = 0;
    const lines: string[] = [];

    for (const item of cart.items) {
      const product = productMap.get(item.productId);
      if (!product) continue;
      const unit = effectiveUnitPrice(
        product.price,
        product.discountPercent,
        product.discountEndsAt,
      );
      const lineTotal = unit * item.quantity;
      total += lineTotal;
      lines.push(
        `• ${product.name} × ${item.quantity} — ${lineTotal.toFixed(2)} ETB`,
      );
    }

    if (lines.length === 0) return;

    const frontendUrl =
      this.configService.get<string>('FRONTEND_URL') ||
      this.configService.get<string>('SHOP_MINI_APP_URL') ||
      'https://medaf-skincare.vercel.app';
    const cartUrl = `${frontendUrl.replace(/\/$/, '')}/shop/cart`;

    const text =
      `🛒 *You have items waiting in your cart!*\n\n` +
      `${lines.join('\n')}\n\n` +
      `💰 *Cart total:* ${total.toFixed(2)} ETB\n\n` +
      `Tap below to complete your order 👇`;

    const keyboard = {
      inline_keyboard: [
        [
          {
            text: '🛒 Continue to Cart',
            web_app: { url: cartUrl },
          },
        ],
        [
          {
            text: '🗑️ Clear Cart',
            callback_data: `clear_cart_${cart.customerId}`,
          },
        ],
      ],
    };

    await this.telegramService.sendMessageSafe(
      String(cart.customer.telegramId),
      text,
      {
        parse_mode: 'Markdown',
        reply_markup: keyboard,
      },
    );
  }
}
