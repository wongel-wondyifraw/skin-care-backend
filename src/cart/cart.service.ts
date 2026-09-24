import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThanOrEqual, Repository } from 'typeorm';
import { Cart, CartItemData } from './cart.entity.js';

@Injectable()
export class CartService {
  constructor(
    @InjectRepository(Cart)
    private readonly repo: Repository<Cart>,
  ) {}

  async syncCart(customerId: string, items: CartItemData[]): Promise<Cart> {
    let cart = await this.repo.findOne({ where: { customerId } });
    if (!cart) {
      cart = this.repo.create({
        customerId,
        items,
        reminderSent: false,
      });
    } else {
      cart.items = items;
      cart.reminderSent = false;
    }
    return this.repo.save(cart);
  }

  async getCart(customerId: string): Promise<Cart | null> {
    return this.repo.findOne({
      where: { customerId },
    });
  }

  async clearCart(customerId: string): Promise<void> {
    const cart = await this.repo.findOne({ where: { customerId } });
    if (cart) {
      cart.items = [];
      cart.reminderSent = false;
      await this.repo.save(cart);
    }
  }

  async findAbandonedCarts(): Promise<Cart[]> {
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const carts = await this.repo.find({
      where: {
        reminderSent: false,
        updatedAt: LessThanOrEqual(twentyFourHoursAgo),
      },
      relations: { customer: true },
    });

    // Filter out carts that have no items
    return carts.filter((c) => Array.isArray(c.items) && c.items.length > 0);
  }

  async markReminded(cartId: string): Promise<void> {
    await this.repo.update(cartId, { reminderSent: true });
  }
}
