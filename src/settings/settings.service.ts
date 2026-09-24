import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Setting } from './setting.entity.js';
import {
  IsString,
  IsArray,
  IsNumber,
  ValidateNested,
  IsNotEmpty,
} from 'class-validator';
import { Type } from 'class-transformer';

export const SHOP_TRENDING_KEY = 'shop_trending_product_ids';
export const DELIVERY_ZONES_KEY = 'delivery_zones';
export const DELIVERY_ORIGIN_KEY = 'delivery_origin';
export const DELIVERY_RATE_KEY = 'delivery_rate';
export const SUPPORT_PHONE_KEY = 'support_phone';
export const PAYMENT_INFO_KEY = 'payment_info';
export const MAX_TRENDING_PRODUCTS = 5;

export class DeliveryZone {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsNumber()
  fee: number;

  @IsArray()
  @IsString({ each: true })
  keywords: string[];
}

export class DeliveryOrigin {
  @IsNumber()
  lat: number;

  @IsNumber()
  lon: number;

  @IsString()
  displayAddress: string;
}

export class DeliveryRate {
  @IsNumber()
  ratePerKm: number;

  @IsNumber()
  minFee: number;

  @IsNumber()
  maxRadiusKm: number;
}

export class BankAccountInfo {
  @IsString()
  bankName: string;

  @IsString()
  accountNumber: string;

  @IsString()
  accountName: string;
}

export class TelebirrInfo {
  @IsString()
  phoneNumber: string;

  @IsString()
  accountName: string;
}

export class PaymentInfo {
  @ValidateNested()
  @Type(() => BankAccountInfo)
  bankAccount: BankAccountInfo;

  @ValidateNested()
  @Type(() => TelebirrInfo)
  telebirr: TelebirrInfo;
}

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
    const existing = await this.settingRepository.findOne({ where: { key } });
    if (existing) {
      existing.value = value;
      await this.settingRepository.save(existing);
    } else {
      await this.settingRepository.save({ key, value });
    }
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

  async getDeliveryZones(): Promise<DeliveryZone[]> {
    const raw = await this.getValue(DELIVERY_ZONES_KEY);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  async setDeliveryZones(zones: DeliveryZone[]): Promise<DeliveryZone[]> {
    if (!Array.isArray(zones)) {
      throw new BadRequestException('delivery zones must be an array');
    }
    await this.setValue(DELIVERY_ZONES_KEY, JSON.stringify(zones));
    return zones;
  }

  async calculateDeliveryFee(
    address?: string | null,
  ): Promise<{ zone: string; fee: number }> {
    if (!address || !address.trim()) {
      return { zone: 'Standard Delivery', fee: 350 };
    }
    const zones = await this.getDeliveryZones();
    const lower = address.toLowerCase();

    for (const zone of zones) {
      if (
        Array.isArray(zone.keywords) &&
        zone.keywords.some((kw) => lower.includes(kw.toLowerCase().trim()))
      ) {
        return { zone: zone.name, fee: Number(zone.fee) || 350 };
      }
    }

    return { zone: 'Other Locations', fee: 350 };
  }

  async getDeliveryOrigin(): Promise<DeliveryOrigin> {
    const raw = await this.getValue(DELIVERY_ORIGIN_KEY);
    if (raw) {
      try {
        return JSON.parse(raw);
      } catch {
        // fallback
      }
    }
    return {
      lat: 9.0192,
      lon: 38.7525,
      displayAddress: 'Addis Ababa',
    };
  }

  async setDeliveryOrigin(origin: DeliveryOrigin): Promise<DeliveryOrigin> {
    await this.setValue(DELIVERY_ORIGIN_KEY, JSON.stringify(origin));
    return origin;
  }

  async getDeliveryRate(): Promise<DeliveryRate> {
    const raw = await this.getValue(DELIVERY_RATE_KEY);
    if (raw) {
      try {
        return JSON.parse(raw);
      } catch {
        // fallback
      }
    }
    return {
      ratePerKm: 25,
      minFee: 50,
      maxRadiusKm: 30,
    };
  }

  async setDeliveryRate(rate: DeliveryRate): Promise<DeliveryRate> {
    await this.setValue(DELIVERY_RATE_KEY, JSON.stringify(rate));
    return rate;
  }

  async getPaymentInfo(): Promise<PaymentInfo> {
    const raw = await this.getValue(PAYMENT_INFO_KEY);
    if (raw) {
      try {
        return JSON.parse(raw);
      } catch {
        // fallback
      }
    }
    return {
      bankAccount: {
        bankName: 'Commercial Bank of Ethiopia (CBE)',
        accountNumber: '1000XXXXXXXX',
        accountName: 'Medaf Skin Care',
      },
      telebirr: {
        phoneNumber: '09XXXXXXXX',
        accountName: 'Medaf Skin Care',
      },
    };
  }

  async setPaymentInfo(info: PaymentInfo): Promise<PaymentInfo> {
    await this.setValue(PAYMENT_INFO_KEY, JSON.stringify(info));
    return info;
  }

  async getSupportPhone(): Promise<string> {
    const raw = await this.getValue(SUPPORT_PHONE_KEY);
    return raw?.trim() || '66XXXXXXXX';
  }

  async setSupportPhone(phone: string): Promise<string> {
    const trimmed = phone.trim();
    await this.setValue(SUPPORT_PHONE_KEY, trimmed);
    return trimmed;
  }

  async getShopSettings() {
    return {
      trendingProductIds: await this.getTrendingProductIds(),
      deliveryZones: await this.getDeliveryZones(),
      paymentInfo: await this.getPaymentInfo(),
      supportPhone: await this.getSupportPhone(),
    };
  }

  async updateShopSettings(body: {
    trendingProductIds?: string[];
    deliveryZones?: DeliveryZone[];
    paymentInfo?: PaymentInfo;
    supportPhone?: string;
  }) {
    if (body.trendingProductIds !== undefined) {
      await this.setTrendingProductIds(body.trendingProductIds);
    }
    if (body.deliveryZones !== undefined) {
      await this.setDeliveryZones(body.deliveryZones);
    }
    if (body.paymentInfo !== undefined) {
      await this.setPaymentInfo(body.paymentInfo);
    }
    if (body.supportPhone !== undefined) {
      await this.setSupportPhone(body.supportPhone);
    }
    return this.getShopSettings();
  }
}
