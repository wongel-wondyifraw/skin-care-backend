import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { CloudinaryService } from '../upload/cloudinary.service.js';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsIn,
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
import { CartService } from '../cart/cart.service.js';
import { PickupLocationService } from '../pickup-location/pickup-location.service.js';
import { LocationIqService } from '../location/locationiq.service.js';
import { CustomerJwtAuthGuard } from './customer-jwt-auth.guard.js';
import { ShopAuthService } from './shop-auth.service.js';
import { customerInitials } from './telegram-webapp.js';
import { OrderStatus } from '../order/order.entity.js';

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

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  deliveryLat?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  deliveryLon?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  deliveryDistanceKm?: number;

  @IsOptional()
  @IsString()
  fulfilmentType?: 'delivery' | 'pickup';

  @IsOptional()
  @IsString()
  pickupLocationId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  deliveryFee?: number;

  @IsOptional()
  @IsString()
  paymentMethod?: string;

  @IsOptional()
  @IsString()
  paymentEvidence?: string;
}

class CartItemDto {
  @IsUUID()
  productId: string;

  @Type(() => Number)
  @IsNumber()
  @Min(1)
  quantity: number;
}

class SyncCartDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CartItemDto)
  items: CartItemDto[];
}

class SubmitPaymentDto {
  @IsIn(['bank', 'telebirr'])
  paymentMethod: 'bank' | 'telebirr';

  @IsString()
  paymentEvidence: string;
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
    private readonly cartService: CartService,
    private readonly pickupLocationService: PickupLocationService,
    private readonly locationIqService: LocationIqService,
    private readonly cloudinaryService: CloudinaryService,
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
      locationLat: customer.locationLat,
      locationLon: customer.locationLon,
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
    @Query('status') status?: OrderStatus | 'all',
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
  async createOrders(
    @Req() req: { user: ShopCustomer },
    @Body() body: CreateShopOrdersDto,
  ) {
    const orders = await this.orderService.createForCustomer(
      req.user.id,
      body.items,
      body,
    );
    await this.cartService.clearCart(req.user.id);
    return orders;
  }

  @UseGuards(CustomerJwtAuthGuard)
  @Post('orders/:id/payment')
  submitPayment(
    @Req() req: { user: ShopCustomer },
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: SubmitPaymentDto,
  ) {
    return this.orderService.submitPaymentEvidence(id, req.user.id, body);
  }

  @UseGuards(CustomerJwtAuthGuard)
  @Get('cart')
  async getCart(@Req() req: { user: ShopCustomer }) {
    const cart = await this.cartService.getCart(req.user.id);
    return cart || { customerId: req.user.id, items: [] };
  }

  @UseGuards(CustomerJwtAuthGuard)
  @Put('cart')
  syncCart(@Req() req: { user: ShopCustomer }, @Body() body: SyncCartDto) {
    return this.cartService.syncCart(req.user.id, body.items);
  }

  @UseGuards(CustomerJwtAuthGuard)
  @Delete('cart')
  async clearCart(@Req() req: { user: ShopCustomer }) {
    await this.cartService.clearCart(req.user.id);
    return { success: true };
  }

  @UseGuards(CustomerJwtAuthGuard)
  @Get('delivery-fee')
  async getDeliveryFee(
    @Query('lat') lat?: string,
    @Query('lon') lon?: string,
  ) {
    const origin = await this.settingsService.getDeliveryOrigin();
    const notes = {
      originDescription: origin.description?.trim() || null,
      originAddress: origin.displayAddress || null,
    };
    if (lat && lon) {
      const fee = await this.locationIqService.calculateDeliveryFee(
        parseFloat(lat),
        parseFloat(lon),
      );
      return { ...fee, ...notes };
    }
    return {
      distanceKm: 0,
      fee: 0,
      durationMinutes: 0,
      withinRadius: false,
      bandLabel: null,
      ...notes,
    };
  }

  @UseGuards(CustomerJwtAuthGuard)
  @Get('delivery-info')
  async getDeliveryInfo() {
    const origin = await this.settingsService.getDeliveryOrigin();
    return {
      displayAddress: origin.displayAddress,
      description: origin.description?.trim() || null,
      lat: origin.lat,
      lon: origin.lon,
    };
  }

  @UseGuards(CustomerJwtAuthGuard)
  @Get('pickup-locations')
  listPickupLocations() {
    return this.pickupLocationService.findEnabled();
  }

  @UseGuards(CustomerJwtAuthGuard)
  @Get('payment-info')
  getPaymentInfo() {
    return this.settingsService.getPaymentInfo();
  }

  @Get('support-phone')
  async getSupportPhone() {
    return { supportPhone: await this.settingsService.getSupportPhone() };
  }

  @UseGuards(CustomerJwtAuthGuard)
  @Post('upload-receipt')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 5 * 1024 * 1024 },
      fileFilter: (_req, file, cb) => {
        if (!/^image\/(jpeg|png|webp|gif|heic|heif)$/i.test(file.mimetype)) {
          return cb(
            new BadRequestException('Only image receipts are allowed'),
            false,
          );
        }
        cb(null, true);
      },
    }),
  )
  async uploadReceipt(@UploadedFile() file: Express.Multer.File) {
    if (!file) throw new BadRequestException('No file provided');
    const result = await this.cloudinaryService.uploadFile(file);
    return { url: result.secure_url };
  }
}
