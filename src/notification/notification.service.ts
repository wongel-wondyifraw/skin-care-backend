import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import {
  AdminNotification,
  AdminNotificationType,
} from './admin-notification.entity.js';

@Injectable()
export class NotificationService {
  constructor(
    @InjectRepository(AdminNotification)
    private readonly repo: Repository<AdminNotification>,
  ) {}

  async create(input: {
    type: AdminNotificationType;
    title: string;
    body: string;
    orderId?: string | null;
    href?: string;
  }): Promise<AdminNotification> {
    const row = this.repo.create({
      type: input.type,
      title: input.title.slice(0, 160),
      body: input.body.slice(0, 400),
      orderId: input.orderId ?? null,
      href: input.href ?? '/admin/orders',
      readAt: null,
    });
    return this.repo.save(row);
  }

  async listRecent(limit = 30): Promise<AdminNotification[]> {
    return this.repo.find({
      order: { createdAt: 'DESC' },
      take: Math.min(50, Math.max(1, limit)),
    });
  }

  async unreadCount(): Promise<number> {
    return this.repo.count({ where: { readAt: IsNull() } });
  }

  async markRead(id: string): Promise<AdminNotification | null> {
    const row = await this.repo.findOne({ where: { id } });
    if (!row) return null;
    if (!row.readAt) {
      row.readAt = new Date();
      await this.repo.save(row);
    }
    return row;
  }

  async markAllRead(): Promise<{ updated: number }> {
    const result = await this.repo
      .createQueryBuilder()
      .update(AdminNotification)
      .set({ readAt: () => 'NOW()' })
      .where('"readAt" IS NULL')
      .execute();
    return { updated: result.affected ?? 0 };
  }
}
