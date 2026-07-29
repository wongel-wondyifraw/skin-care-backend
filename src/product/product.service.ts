import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ILike, Repository } from 'typeorm';
import { Product } from './product.entity';
import { SkinType } from '../skin-type/skin-type.entity';

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ProductListQuery {
  page?: number;
  pageSize?: number;
  search?: string;
  categoryId?: string;
  skinTypeId?: string;
  stock?: 'all' | 'in_stock' | 'low_stock' | 'out_of_stock';
}

@Injectable()
export class ProductService {
  constructor(
    @InjectRepository(Product)
    private productRepository: Repository<Product>,
  ) {}

  async findAll(): Promise<Product[]> {
    return this.productRepository.find({
      relations: { category: true, skinType: true },
      order: { createdAt: 'DESC' },
    });
  }

  async findPage(query: ProductListQuery): Promise<PaginatedResult<Product>> {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(50, Math.max(1, query.pageSize ?? 12));

    const qb = this.productRepository
      .createQueryBuilder('product')
      .leftJoinAndSelect('product.category', 'category')
      .leftJoinAndSelect('product.skinType', 'skinType')
      .orderBy('product.createdAt', 'DESC')
      .skip((page - 1) * pageSize)
      .take(pageSize);

    const search = query.search?.trim();
    if (search) {
      qb.andWhere('LOWER(product.name) LIKE :search', {
        search: `%${search.toLowerCase()}%`,
      });
    }

    if (query.categoryId) {
      qb.andWhere('product.categoryId = :categoryId', {
        categoryId: query.categoryId,
      });
    }

    if (query.skinTypeId) {
      qb.andWhere('product.skinTypeId = :skinTypeId', {
        skinTypeId: query.skinTypeId,
      });
    }

    if (query.stock === 'out_of_stock') {
      qb.andWhere('product.stock = 0');
    } else if (query.stock === 'low_stock') {
      qb.andWhere('product.stock > 0 AND product.stock < 10');
    } else if (query.stock === 'in_stock') {
      qb.andWhere('product.stock > 0');
    }

    const [items, total] = await qb.getManyAndCount();
    return { items, total, page, pageSize };
  }

  private async findHydratedById(id: string): Promise<Product> {
    const product = await this.productRepository.findOne({
      where: { id },
      relations: { category: true, skinType: true },
    });
    if (!product) {
      throw new NotFoundException(`Product with ID ${id} not found`);
    }
    return product;
  }

  async findOne(id: string): Promise<Product> {
    return this.findHydratedById(id);
  }

  private async findOrCreateAllSkinType(): Promise<SkinType> {
    const skinTypeRepo = this.productRepository.manager.getRepository(SkinType);
    let allSkin = await skinTypeRepo.findOne({ where: { name: 'All' } });
    if (!allSkin) {
      allSkin = skinTypeRepo.create({
        name: 'All',
        description: 'Suitable for all skin types',
      });
      allSkin = await skinTypeRepo.save(allSkin);
    }
    return allSkin;
  }

  async create(data: Partial<Product>): Promise<Product> {
    const name = data.name?.trim();
    if (name) {
      const existing = await this.productRepository.findOne({
        where: { name: ILike(name) },
      });
      if (existing) {
        throw new ConflictException(
          `A product named "${existing.name}" already exists. Use Restock to add inventory instead of creating a duplicate.`,
        );
      }
      data.name = name;
    }

    if (!data.skinTypeId) {
      const allSkin = await this.findOrCreateAllSkinType();
      data.skinTypeId = allSkin.id;
    }
    const product = this.productRepository.create(data);
    const saved = await this.productRepository.save(product);
    return this.findHydratedById(saved.id);
  }

  async restock(id: string, quantity: number): Promise<Product> {
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new BadRequestException('Restock quantity must be a positive number.');
    }
    const product = await this.findHydratedById(id);
    product.stock = (product.stock ?? 0) + Math.floor(quantity);
    await this.productRepository.save(product);
    return this.findHydratedById(id);
  }

  async update(id: string, data: Partial<Product>): Promise<Product> {
    if (
      Object.prototype.hasOwnProperty.call(data, 'skinTypeId') &&
      !data.skinTypeId
    ) {
      const allSkin = await this.findOrCreateAllSkinType();
      data.skinTypeId = allSkin.id;
    }
    const product = await this.findHydratedById(id);
    Object.assign(product, data);
    await this.productRepository.save(product);
    return this.findHydratedById(id);
  }

  async remove(id: string): Promise<void> {
    const result = await this.productRepository.delete(id);
    if (result.affected === 0) {
      throw new NotFoundException(`Product with ID ${id} not found`);
    }
  }
}
