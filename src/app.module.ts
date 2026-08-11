import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { AdminUser } from './admin-user/admin-user.entity.js';
import { SkinType } from './skin-type/skin-type.entity.js';
import { Category } from './category/category.entity.js';
import { Product } from './product/product.entity.js';
import { Customer } from './customer/customer.entity.js';
import { CustomerMessage } from './customer/customer-message.entity.js';
import { SkinAnalysis } from './skin-analysis/skin-analysis.entity.js';
import { Order } from './order/order.entity.js';
import { Setting } from './settings/setting.entity.js';
import { AdminNotification } from './notification/admin-notification.entity.js';
import { AdminUserModule } from './admin-user/admin-user.module.js';
import { AuthModule } from './auth/auth.module.js';
import { SeedModule } from './seed/seed.module.js';
import { SkinTypeModule } from './skin-type/skin-type.module.js';
import { CategoryModule } from './category/category.module.js';
import { ProductModule } from './product/product.module.js';
import { UploadModule } from './upload/upload.module.js';
import { TelegramModule } from './telegram/telegram.module.js';
import { CustomerModule } from './customer/customer.module.js';
import { SkinAnalysisModule } from './skin-analysis/skin-analysis.module.js';
import { OrderModule } from './order/order.module.js';
import { ShopModule } from './shop/shop.module.js';
import { SettingsModule } from './settings/settings.module.js';
import { NotificationModule } from './notification/notification.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forFeature([
      AdminUser,
      SkinType,
      Category,
      Product,
      Customer,
      CustomerMessage,
      SkinAnalysis,
      Order,
      Setting,
      AdminNotification,
    ]),

    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const databaseUrl = config.get<string>('DATABASE_URL');

        // Supabase / Render: use the full connection string.
        // The transaction-mode pooler (port 6543) requires ssl + no prepared statements.
        if (databaseUrl) {
          return {
            type: 'postgres',
            url: databaseUrl,
            entities: [
              AdminUser,
              SkinType,
              Category,
              Product,
              Customer,
              CustomerMessage,
              SkinAnalysis,
              Order,
              Setting,
              AdminNotification,
            ],
            synchronize: true,
            ssl: { rejectUnauthorized: false },
            // pgbouncer transaction mode does not support prepared statements
            extra: { max: 10 },
          };
        }

        // Local development: use individual connection fields.
        return {
          type: 'postgres',
          host: config.get<string>('DB_HOST', 'localhost'),
          port: config.get<number>('DB_PORT', 5432),
          username: config.get<string>('DB_USERNAME', 'postgres'),
          password: config.get<string>('DB_PASSWORD', 'postgres'),
          database: config.get<string>('DB_NAME', 'medaf_skincare'),
          entities: [
            AdminUser,
            SkinType,
            Category,
            Product,
            Customer,
            CustomerMessage,
            SkinAnalysis,
            Order,
            Setting,
            AdminNotification,
          ],
          synchronize: true,
        };
      },
    }),

    AdminUserModule,
    AuthModule,
    SeedModule,
    SkinTypeModule,
    CategoryModule,
    ProductModule,
    UploadModule,
    TelegramModule,
    CustomerModule,
    SkinAnalysisModule,
    OrderModule,
    ShopModule,
    SettingsModule,
    NotificationModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
