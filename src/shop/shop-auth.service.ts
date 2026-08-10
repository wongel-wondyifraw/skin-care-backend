import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { CustomerService } from '../customer/customer.service.js';
import { customerInitials } from './telegram-webapp.js';
import type { CustomerJwtPayload } from './customer-jwt.strategy.js';

@Injectable()
export class ShopAuthService {
  constructor(
    private readonly config: ConfigService,
    private readonly jwtService: JwtService,
    private readonly customerService: CustomerService,
  ) {}

  private customerSecret() {
    return (
      this.config.get<string>('CUSTOMER_JWT_SECRET') ||
      `${this.config.get<string>('JWT_SECRET') || 'medaf'}-customer`
    );
  }

  /** Simple auth: match Telegram user id to the customers table. */
  async loginWithTelegramId(telegramIdRaw: number | string) {
    const telegramId = Number(telegramIdRaw);
    if (!Number.isFinite(telegramId) || telegramId <= 0) {
      throw new BadRequestException('A valid Telegram user id is required');
    }

    const customer = await this.customerService.findByTelegramId(telegramId);
    if (!customer) {
      throw new ForbiddenException(
        'Please finish registration in the Medaf bot with /start before browsing products.',
      );
    }

    const payload: CustomerJwtPayload = {
      sub: customer.id,
      telegramId: Number(customer.telegramId),
      fullName: customer.fullName,
    };

    const accessToken = await this.jwtService.signAsync(payload, {
      secret: this.customerSecret(),
      expiresIn: '24h',
      audience: 'customer',
    });

    return {
      accessToken,
      customer: {
        id: customer.id,
        fullName: customer.fullName,
        initials: customerInitials(customer.fullName),
        telegramId: Number(customer.telegramId),
        phone: customer.phone,
        address: customer.address,
        skinType: customer.skinType
          ? { id: customer.skinType.id, name: customer.skinType.name }
          : null,
      },
    };
  }
}
