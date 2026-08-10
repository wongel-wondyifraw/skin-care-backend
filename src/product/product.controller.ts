import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Delete,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsNumber,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ProductService } from './product.service';
import type { ProductWriteInput } from './product.service';

class BulkDiscountDto {
  @IsArray()
  @ArrayMinSize(1)
  @IsUUID('4', { each: true })
  productIds: string[];

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  discountPercent: number;
}

@UseGuards(JwtAuthGuard)
@Controller('products')
export class ProductController {
  constructor(private readonly productService: ProductService) {}

  @Get()
  findAll(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('search') search?: string,
    @Query('categoryId') categoryId?: string,
    @Query('skinTypeId') skinTypeId?: string,
    @Query('stock') stock?: 'all' | 'in_stock' | 'low_stock' | 'out_of_stock',
    @Query('sort') sort?: 'name' | 'recent',
    @Query('discounted') discounted?: string,
  ) {
    return this.productService.findPage({
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
      search,
      categoryId,
      skinTypeId,
      stock,
      sort,
      discounted:
        discounted === '1' ||
        discounted === 'true' ||
        discounted === 'yes',
    });
  }

  @Patch('discounts')
  setDiscounts(@Body() body: BulkDiscountDto) {
    return this.productService.setDiscounts(
      body.productIds,
      body.discountPercent,
    );
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.productService.findOne(id);
  }

  @Post()
  create(@Body() body: ProductWriteInput) {
    return this.productService.create(body);
  }

  @Patch(':id/restock')
  restock(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { quantity: number },
  ) {
    return this.productService.restock(id, Number(body.quantity));
  }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ProductWriteInput,
  ) {
    return this.productService.update(id, body);
  }

  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.productService.remove(id);
  }
}
