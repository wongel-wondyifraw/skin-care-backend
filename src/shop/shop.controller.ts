import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsNumber, IsOptional, IsString } from 'class-validator';
import { ProductService } from '../product/product.service.js';
import { CategoryService } from '../category/category.service.js';
import { SkinTypeService } from '../skin-type/skin-type.service.js';
import { CustomerJwtAuthGuard } from './customer-jwt-auth.guard.js';
import { ShopAuthService } from './shop-auth.service.js';
import { customerInitials } from './telegram-webapp.js';

class TelegramAuthDto {
  /** Preferred: Telegram user id from WebApp.initDataUnsafe.user.id */
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  telegramId?: number;

  /** Optional legacy field — ignored for auth, kept for older clients */
  @IsOptional()
  @IsString()
  initData?: string;
}

type ShopCustomer = {
  id: string;
  telegramId: number;
  fullName: string;
};

@Controller('shop')
export class ShopController {
  constructor(
    private readonly shopAuthService: ShopAuthService,
    private readonly productService: ProductService,
    private readonly categoryService: CategoryService,
    private readonly skinTypeService: SkinTypeService,
  ) {}

  @Post('auth/telegram')
  @HttpCode(HttpStatus.OK)
  login(@Body() body: TelegramAuthDto) {
    return this.shopAuthService.loginWithTelegramId(body.telegramId as number);
  }

  @UseGuards(CustomerJwtAuthGuard)
  @Get('me')
  me(@Req() req: { user: ShopCustomer }) {
    return {
      id: req.user.id,
      fullName: req.user.fullName,
      initials: customerInitials(req.user.fullName),
      telegramId: req.user.telegramId,
    };
  }

  @UseGuards(CustomerJwtAuthGuard)
  @Get('products')
  listProducts(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('search') search?: string,
    @Query('categoryId') categoryId?: string,
    @Query('skinTypeId') skinTypeId?: string,
    @Query('stock') stock?: 'all' | 'in_stock' | 'low_stock' | 'out_of_stock',
    @Query('sort') sort?: 'name' | 'recent',
  ) {
    return this.productService.findPage({
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
      search,
      categoryId,
      skinTypeId,
      stock,
      sort,
    });
  }

  @UseGuards(CustomerJwtAuthGuard)
  @Get('products/:id')
  getProduct(@Param('id', ParseUUIDPipe) id: string) {
    return this.productService.findOne(id);
  }

  @UseGuards(CustomerJwtAuthGuard)
  @Get('categories')
  listCategories() {
    return this.categoryService.findAll();
  }

  @UseGuards(CustomerJwtAuthGuard)
  @Get('skin-types')
  listSkinTypes() {
    return this.skinTypeService.findAll();
  }
}
