import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Setting } from './setting.entity.js';
import {
  IsString,
  IsArray,
  IsNumber,
  ValidateNested,
  IsOptional,
} from 'class-validator';
import { Type } from 'class-transformer';

export const SHOP_TRENDING_KEY = 'shop_trending_product_ids';
export const DELIVERY_ORIGIN_KEY = 'delivery_origin';
export const DELIVERY_RATE_KEY = 'delivery_rate';
export const SUPPORT_PHONE_KEY = 'support_phone';
export const PAYMENT_INFO_KEY = 'payment_info';
export const MAX_TRENDING_PRODUCTS = 5;

export class DeliveryOrigin {
  @IsNumber()
  lat: number;

  @IsNumber()
  lon: number;

  @IsString()
  displayAddress: string;
}

export class DeliveryBand {
  @IsNumber()
  fromKm: number;

  @IsNumber()
  toKm: number;

  @IsNumber()
  fee: number;
}

export class DeliveryRate {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DeliveryBand)
  bands: DeliveryBand[];

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

const DEFAULT_DELIVERY_RATE: DeliveryRate = {
  bands: [
    { fromKm: 0, toKm: 5, fee: 100 },
    { fromKm: 5, toKm: 15, fee: 200 },
    { fromKm: 15, toKm: 30, fee: 350 },
  ],
  maxRadiusKm: 30,
};

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
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        return this.normalizeDeliveryRate(parsed);
      } catch {
        // fallback
      }
    }
    return { ...DEFAULT_DELIVERY_RATE, bands: [...DEFAULT_DELIVERY_RATE.bands] };
  }

  /** Migrate legacy ratePerKm/minFee shape → bands */
  normalizeDeliveryRate(parsed: Record<string, unknown>): DeliveryRate {
    if (Array.isArray(parsed.bands) && parsed.bands.length > 0) {
      const bands = (parsed.bands as DeliveryBand[])
        .map((b) => ({
          fromKm: Number(b.fromKm) || 0,
          toKm: Number(b.toKm) || 0,
          fee: Number(b.fee) || 0,
        }))
        .filter((b) => b.toKm > b.fromKm && b.fee >= 0)
        .sort((a, b) => a.fromKm - b.fromKm);
      const maxRadiusKm =
        Number(parsed.maxRadiusKm) ||
        Math.max(...bands.map((b) => b.toKm), 30);
      return { bands, maxRadiusKm };
    }

    // Legacy: { ratePerKm, minFee, maxRadiusKm }
    const maxRadiusKm = Number(parsed.maxRadiusKm) || 30;
    const minFee = Number(parsed.minFee) || 50;
    return {
      bands: [{ fromKm: 0, toKm: maxRadiusKm, fee: minFee }],
      maxRadiusKm,
    };
  }

  async setDeliveryRate(rate: DeliveryRate): Promise<DeliveryRate> {
    const normalized = this.normalizeDeliveryRate(
      rate as unknown as Record<string, unknown>,
    );
    if (!normalized.bands.length) {
      throw new BadRequestException('At least one KM band is required');
    }
    await this.setValue(DELIVERY_RATE_KEY, JSON.stringify(normalized));
    return normalized;
  }

  /**
   * Pick flat fee for a driving distance using configured KM bands.
   */
  feeForDistanceKm(
    distanceKm: number,
    rate: DeliveryRate,
  ): { fee: number; withinRadius: boolean; bandLabel: string | null } {
    if (!Number.isFinite(distanceKm) || distanceKm < 0) {
      return { fee: 0, withinRadius: false, bandLabel: null };
    }
    if (distanceKm > rate.maxRadiusKm) {
      return { fee: 0, withinRadius: false, bandLabel: null };
    }
    const band = rate.bands.find(
      (b) => distanceKm >= b.fromKm && distanceKm <= b.toKm,
    );
    if (!band) {
      // Gap between bands: use next band that covers above fromKm
      const next = rate.bands.find((b) => distanceKm <= b.toKm);
      if (!next) {
        return { fee: 0, withinRadius: false, bandLabel: null };
      }
      return {
        fee: Math.ceil(next.fee),
        withinRadius: true,
        bandLabel: `${next.fromKm}–${next.toKm} km`,
      };
    }
    return {
      fee: Math.ceil(band.fee),
      withinRadius: true,
      bandLabel: `${band.fromKm}–${band.toKm} km`,
    };
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
      paymentInfo: await this.getPaymentInfo(),
      supportPhone: await this.getSupportPhone(),
      deliveryOrigin: await this.getDeliveryOrigin(),
      deliveryRate: await this.getDeliveryRate(),
    };
  }

  async updateShopSettings(body: {
    trendingProductIds?: string[];
    paymentInfo?: PaymentInfo;
    supportPhone?: string;
  }) {
    if (body.trendingProductIds !== undefined) {
      await this.setTrendingProductIds(body.trendingProductIds);
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
