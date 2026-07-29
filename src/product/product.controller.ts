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
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ProductService } from './product.service';

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
  ) {
    if (
      page !== undefined ||
      pageSize !== undefined ||
      search !== undefined ||
      categoryId !== undefined ||
      skinTypeId !== undefined ||
      stock !== undefined
    ) {
      return this.productService.findPage({
        page: page ? Number(page) : undefined,
        pageSize: pageSize ? Number(pageSize) : undefined,
        search,
        categoryId,
        skinTypeId,
        stock,
      });
    }

    return this.productService.findAll();
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.productService.findOne(id);
  }

  @Post()
  create(
    @Body()
    body: {
      name: string;
      description?: string;
      image: string;
      assetId?: string;
      categoryId?: string;
      skinTypeId?: string;
      stock?: number;
    },
  ) {
    return this.productService.create(body);
  }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body()
    body: {
      image?: string;
      assetId?: string;
      stock?: number;
      name?: string;
      description?: string;
      categoryId?: string;
      skinTypeId?: string;
    },
  ) {
    return this.productService.update(id, body);
  }

  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.productService.remove(id);
  }
}
