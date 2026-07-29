import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Product } from './product/product.entity.js';
import { Category } from './category/category.entity.js';
import { SkinType } from './skin-type/skin-type.entity.js';
import { Customer } from './customer/customer.entity.js';

@Injectable()
export class AppService {
  constructor(
    @InjectRepository(Product)
    private readonly productRepository: Repository<Product>,
    @InjectRepository(Category)
    private readonly categoryRepository: Repository<Category>,
    @InjectRepository(SkinType)
    private readonly skinTypeRepository: Repository<SkinType>,
    @InjectRepository(Customer)
    private readonly customerRepository: Repository<Customer>,
  ) {}

  getHello(): string {
    return 'Hello World!';
  }

  async getDashboardSummary() {
    const [products, categories, skinTypes, customers] = await Promise.all([
      this.productRepository.count(),
      this.categoryRepository.count(),
      this.skinTypeRepository.count(),
      this.customerRepository.count(),
    ]);

    return {
      products,
      categories,
      skinTypes,
      customers,
    };
  }
}
