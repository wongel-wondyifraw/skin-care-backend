import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { AdminUser } from './admin-user/admin-user.entity.js';
import { SkinType } from './skin-type/skin-type.entity.js';
import { Category } from './category/category.entity.js';
import { Product } from './product/product.entity.js';
import { AdminUserModule } from './admin-user/admin-user.module.js';
import { AuthModule } from './auth/auth.module.js';
import { SeedModule } from './seed/seed.module.js';
import { SkinTypeModule } from './skin-type/skin-type.module.js';
import { CategoryModule } from './category/category.module.js';
import { ProductModule } from './product/product.module.js';
import { UploadModule } from './upload/upload.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),

    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        host: config.get<string>('DB_HOST', 'localhost'),
        port: config.get<number>('DB_PORT', 5432),
        username: config.get<string>('DB_USERNAME', 'postgres'),
        password: config.get<string>('DB_PASSWORD', 'postgres'),
        database: config.get<string>('DB_NAME', 'medaf_skincare'),
        entities: [AdminUser, SkinType, Category, Product],
        synchronize: true,
      }),
    }),

    AdminUserModule,
    AuthModule,
    SeedModule,
    SkinTypeModule,
    CategoryModule,
    ProductModule,
    UploadModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
