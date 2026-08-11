import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';
import { ProductService } from '../product/product.service.js';
import { CategoryService } from '../category/category.service.js';
import { SkinTypeService } from '../skin-type/skin-type.service.js';
import { OrderService } from '../order/order.service.js';
import { CustomerService } from '../customer/customer.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { CustomerJwtAuthGuard } from './customer-jwt-auth.guard.js';
import { ShopAuthService } from './shop-auth.service.js';
import { customerInitials } from './telegram-webapp.js';

class TelegramAuthDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  telegramId?: number;

  @IsOptional()
  @IsString()
  initData?: string;
}

class ShopOrderItemDto {
  @IsUUID()
  productId: string;

  @Type(() => Number)
  @IsNumber()
  @Min(1)
  quantity: number;
}

class CreateShopOrdersDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ShopOrderItemDto)
  items: ShopOrderItemDto[];

  @IsOptional()
  @IsString()
  deliveryAddress?: string;
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
    private readonly orderService: OrderService,
    private readonly customerService: CustomerService,
    private readonly settingsService: SettingsService,
  ) {}

  @Post('auth/telegram')
  @HttpCode(HttpStatus.OK)
  login(@Body() body: TelegramAuthDto) {
    return this.shopAuthService.loginWithTelegramId(body.telegramId as number);
  }

  @UseGuards(CustomerJwtAuthGuard)
  @Get('me')
  async me(@Req() req: { user: ShopCustomer }) {
    const customer = await this.customerService.findOne(req.user.id);
    return {
      id: customer.id,
      fullName: customer.fullName,
      initials: customerInitials(customer.fullName),
      telegramId: Number(customer.telegramId),
      phone: customer.phone,
      address: customer.address,
      skinType: customer.skinType
        ? { id: customer.skinType.id, name: customer.skinType.name }
        : null,
    };
  }

  @UseGuards(CustomerJwtAuthGuard)
  @Get('trending')
  async listTrending() {
    const ids = await this.settingsService.getTrendingProductIds();
    if (ids.length) {
      const products = await this.productService.findByIdsOrdered(ids);
      const inStock = products.filter((p) => (p.stock ?? 0) > 0 && p.image);
      if (inStock.length) return inStock;
    }
    const fallback = await this.productService.findPage({
      page: 1,
      pageSize: 5,
      sort: 'recent',
      stock: 'in_stock',
    });
    return fallback.items.filter((p) => Boolean(p.image));
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

  @UseGuards(CustomerJwtAuthGuard)
  @Get('orders')
  listOrders(
    @Req() req: { user: ShopCustomer },
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('status') status?: 'pending' | 'delivered' | 'cancelled' | 'all',
  ) {
    return this.orderService.findPageForCustomer(req.user.id, {
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
      status,
    });
  }

  @UseGuards(CustomerJwtAuthGuard)
  @Get('orders/:id')
  getOrder(
    @Req() req: { user: ShopCustomer },
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.orderService.findOneForCustomer(id, req.user.id);
  }

  @UseGuards(CustomerJwtAuthGuard)
  @Patch('orders/:id/cancel')
  cancelOrder(
    @Req() req: { user: ShopCustomer },
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.orderService.cancelForCustomer(id, req.user.id);
  }

  @UseGuards(CustomerJwtAuthGuard)
  @Post('orders')
  @HttpCode(HttpStatus.CREATED)
  createOrders(
    @Req() req: { user: ShopCustomer },
    @Body() body: CreateShopOrdersDto,
  ) {
    return this.orderService.createForCustomer(
      req.user.id,
      body.items,
      body.deliveryAddress,
    );
  }
}
