import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { CustomerService } from '../customer/customer.service.js';
import {
  customerInitials,
  validateTelegramWebAppInitData,
} from './telegram-webapp.js';
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

  async loginWithInitData(initData: string) {
    const botToken = this.config.get<string>('TELEGRAM_BOT_TOKEN');
    if (!botToken) {
      throw new UnauthorizedException('Telegram bot is not configured');
    }

    const { user } = validateTelegramWebAppInitData(initData, botToken);
    const customer = await this.customerService.findByTelegramId(user.id);
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
        phone: customer.phone,
        skinType: customer.skinType
          ? { id: customer.skinType.id, name: customer.skinType.name }
          : null,
      },
    };
  }
}
