import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { CustomerModule } from '../customer/customer.module.js';
import { ProductModule } from '../product/product.module.js';
import { CategoryModule } from '../category/category.module.js';
import { SkinTypeModule } from '../skin-type/skin-type.module.js';
import { ShopController } from './shop.controller.js';
import { ShopAuthService } from './shop-auth.service.js';
import { CustomerJwtStrategy } from './customer-jwt.strategy.js';
import { CustomerJwtAuthGuard } from './customer-jwt-auth.guard.js';

@Module({
  imports: [
    ConfigModule,
    PassportModule,
    CustomerModule,
    ProductModule,
    CategoryModule,
    SkinTypeModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret:
          config.get<string>('CUSTOMER_JWT_SECRET') ||
          `${config.get<string>('JWT_SECRET') || 'medaf'}-customer`,
      }),
    }),
  ],
  controllers: [ShopController],
  providers: [ShopAuthService, CustomerJwtStrategy, CustomerJwtAuthGuard],
  exports: [CustomerJwtAuthGuard],
})
export class ShopModule {}
