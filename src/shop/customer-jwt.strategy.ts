import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { CustomerService } from '../customer/customer.service.js';

export type CustomerJwtPayload = {
  sub: string;
  telegramId: number;
  fullName: string;
};

@Injectable()
export class CustomerJwtStrategy extends PassportStrategy(
  Strategy,
  'customer-jwt',
) {
  constructor(
    configService: ConfigService,
    private readonly customerService: CustomerService,
  ) {
    const secret =
      configService.get<string>('CUSTOMER_JWT_SECRET') ||
      `${configService.get<string>('JWT_SECRET') || 'medaf'}-customer`;

    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: secret,
      audience: 'customer',
    });
  }

  async validate(payload: CustomerJwtPayload) {
    if (!payload?.sub) {
      throw new UnauthorizedException('Invalid customer token');
    }
    const customer = await this.customerService.findOne(payload.sub);
    return {
      id: customer.id,
      telegramId: Number(customer.telegramId),
      fullName: customer.fullName,
    };
  }
}
