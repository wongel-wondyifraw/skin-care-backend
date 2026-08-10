import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Setting } from './setting.entity.js';

export const SHOP_TRENDING_KEY = 'shop_trending_product_ids';
export const MAX_TRENDING_PRODUCTS = 5;

@Injectable()
export class SettingsService {
  constructor(
    @InjectRepository(Setting)
    private readonly settingRepository: Repository<Setting>,
  ) {}

  async getValue(key: string): Promise<string | null> {
    const row = await this.settingRepository.findOne({ where: { key } });
    return row?.value ?? null;
  }

  async setValue(key: string, value: string): Promise<void> {
    await this.settingRepository.save({ key, value });
  }

  async getTrendingProductIds(): Promise<string[]> {
    const raw = await this.getValue(SHOP_TRENDING_KEY);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((id): id is string => typeof id === 'string' && id.length > 0)
        .slice(0, MAX_TRENDING_PRODUCTS);
    } catch {
      return [];
    }
  }

  async setTrendingProductIds(ids: string[]): Promise<string[]> {
    if (!Array.isArray(ids)) {
      throw new BadRequestException('trendingProductIds must be an array');
    }
    const unique: string[] = [];
    for (const id of ids) {
      if (typeof id !== 'string' || !id.trim()) continue;
      const trimmed = id.trim();
      if (unique.includes(trimmed)) continue;
      unique.push(trimmed);
      if (unique.length >= MAX_TRENDING_PRODUCTS) break;
    }
    await this.setValue(SHOP_TRENDING_KEY, JSON.stringify(unique));
    return unique;
  }

  async getShopSettings() {
    return {
      trendingProductIds: await this.getTrendingProductIds(),
    };
  }

  async updateShopSettings(body: { trendingProductIds?: string[] }) {
    if (body.trendingProductIds !== undefined) {
      await this.setTrendingProductIds(body.trendingProductIds);
    }
    return this.getShopSettings();
  }
}
