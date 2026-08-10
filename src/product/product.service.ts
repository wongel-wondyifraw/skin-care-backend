import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, ILike, In, Repository } from 'typeorm';
import { Product } from './product.entity';
import { SkinType } from '../skin-type/skin-type.entity';
import { clampDiscountPercent } from './product-pricing';

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
  sort?: 'name' | 'recent';
}

export type ProductWriteInput = {
  name?: string;
  brand?: string | null;
  description?: string;
  image?: string;
  assetId?: string;
  categoryId?: string | null;
  skinTypeId?: string | null;
  skinTypeIds?: string[];
  stock?: number;
  price?: number;
  discountPercent?: number;
};

@Injectable()
export class ProductService implements OnModuleInit {
  private readonly logger = new Logger(ProductService.name);

  constructor(
    @InjectRepository(Product)
    private productRepository: Repository<Product>,
    @InjectRepository(SkinType)
    private skinTypeRepository: Repository<SkinType>,
    private dataSource: DataSource,
  ) {}

  /** Additive schema fixes for production DBs where synchronize lagged (e.g. pooler). */
  async onModuleInit() {
    try {
      await this.dataSource.query(`
        ALTER TABLE products
        ADD COLUMN IF NOT EXISTS brand character varying(120)
      `);
      await this.dataSource.query(`
        ALTER TABLE products
        ADD COLUMN IF NOT EXISTS "discountPercent" integer DEFAULT 0 NOT NULL
      `);
      await this.dataSource.query(`
        CREATE TABLE IF NOT EXISTS product_skin_types (
          "productId" uuid NOT NULL,
          "skinTypeId" uuid NOT NULL,
          CONSTRAINT "PK_product_skin_types" PRIMARY KEY ("productId", "skinTypeId"),
          CONSTRAINT "FK_product_skin_types_product"
            FOREIGN KEY ("productId") REFERENCES products(id) ON DELETE CASCADE ON UPDATE CASCADE,
          CONSTRAINT "FK_product_skin_types_skin"
            FOREIGN KEY ("skinTypeId") REFERENCES skins(id) ON DELETE CASCADE ON UPDATE CASCADE
        )
      `);
      await this.dataSource.query(`
        INSERT INTO product_skin_types ("productId", "skinTypeId")
        SELECT id, "skinTypeId" FROM products
        WHERE "skinTypeId" IS NOT NULL
        ON CONFLICT DO NOTHING
      `);
    } catch (err) {
      this.logger.warn(
        `Product schema ensure skipped/failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private hydrateLegacySkinTypes(product: Product): Product {
    if (
      (!product.skinTypes || product.skinTypes.length === 0) &&
      product.skinType
    ) {
      product.skinTypes = [product.skinType];
    }
    return product;
  }

  async findAll(): Promise<Product[]> {
    const products = await this.productRepository.find({
      relations: { category: true, skinType: true, skinTypes: true },
      order: { createdAt: 'DESC' },
    });
    return products.map((p) => this.hydrateLegacySkinTypes(p));
  }

  async findPage(query: ProductListQuery): Promise<PaginatedResult<Product>> {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(50, Math.max(1, query.pageSize ?? 12));

    const qb = this.productRepository
      .createQueryBuilder('product')
      .leftJoinAndSelect('product.category', 'category')
      .leftJoinAndSelect('product.skinType', 'skinType')
      .leftJoinAndSelect('product.skinTypes', 'skinTypes')
      .skip((page - 1) * pageSize)
      .take(pageSize);

    // Many-to-many joins make TypeORM use SELECT DISTINCT. Postgres then requires
    // ORDER BY expressions to appear in the select list — avoid bare LOWER(...).
    const sort = query.sort === 'recent' ? 'recent' : 'name';
    if (sort === 'recent') {
      qb.orderBy('product.createdAt', 'DESC');
    } else {
      qb.addSelect('LOWER(product.name)', 'product_name_sort').orderBy(
        'product_name_sort',
        'ASC',
      );
    }

    const search = query.search?.trim();
    if (search) {
      qb.andWhere(
        '(LOWER(product.name) LIKE :search OR LOWER(COALESCE(product.brand, \'\')) LIKE :search)',
        { search: `%${search.toLowerCase()}%` },
      );
    }

    if (query.categoryId) {
      qb.andWhere('product.categoryId = :categoryId', {
        categoryId: query.categoryId,
      });
    }

    if (query.skinTypeId) {
      qb.andWhere(
        '(skinTypes.id = :skinTypeId OR product.skinTypeId = :skinTypeId)',
        { skinTypeId: query.skinTypeId },
      );
    }

    if (query.stock === 'out_of_stock') {
      qb.andWhere('product.stock = 0');
    } else if (query.stock === 'low_stock') {
      qb.andWhere('product.stock > 0 AND product.stock < 10');
    } else if (query.stock === 'in_stock') {
      qb.andWhere('product.stock > 0');
    }

    const items = await qb.getMany();
    const total = await qb
      .clone()
      .skip(undefined as never)
      .take(undefined as never)
      .orderBy()
      .select('product.id')
      .distinct(true)
      .getCount();

    return {
      items: items.map((p) => this.hydrateLegacySkinTypes(p)),
      total,
      page,
      pageSize,
    };
  }

  async findCatalogForAdvice(limit = 100): Promise<Product[]> {
    const products = await this.productRepository.find({
      relations: { category: true, skinType: true, skinTypes: true },
      order: { name: 'ASC' },
      take: Math.min(150, Math.max(1, limit)),
    });
    return products.map((p) => this.hydrateLegacySkinTypes(p));
  }

  private async findHydratedById(id: string): Promise<Product> {
    const product = await this.productRepository.findOne({
      where: { id },
      relations: { category: true, skinType: true, skinTypes: true },
    });
    if (!product) {
      throw new NotFoundException(`Product with ID ${id} not found`);
    }
    return this.hydrateLegacySkinTypes(product);
  }

  async findOne(id: string): Promise<Product> {
    return this.findHydratedById(id);
  }

  /** Resolve products by id, preserving the requested order. */
  async findByIdsOrdered(ids: string[]): Promise<Product[]> {
    if (!ids.length) return [];
    const products = await this.productRepository.find({
      where: { id: In(ids) },
      relations: { category: true, skinType: true, skinTypes: true },
    });
    const byId = new Map(
      products.map((p) => [p.id, this.hydrateLegacySkinTypes(p)]),
    );
    return ids
      .map((id) => byId.get(id))
      .filter((p): p is Product => Boolean(p));
  }

  async setDiscounts(
    productIds: string[],
    discountPercent: number,
  ): Promise<{ updated: number; discountPercent: number }> {
    if (!Array.isArray(productIds) || productIds.length === 0) {
      throw new BadRequestException('Select at least one product');
    }
    const pct = clampDiscountPercent(discountPercent);
    const result = await this.productRepository.update(
      { id: In(productIds) },
      { discountPercent: pct },
    );
    return { updated: result.affected ?? 0, discountPercent: pct };
  }

  private async findOrCreateAllSkinType(): Promise<SkinType> {
    let allSkin = await this.skinTypeRepository.findOne({
      where: { name: 'All' },
    });
    if (!allSkin) {
      allSkin = this.skinTypeRepository.create({
        name: 'All',
        description: 'Suitable for all skin types',
      });
      allSkin = await this.skinTypeRepository.save(allSkin);
    }
    return allSkin;
  }

  private async resolveSkinTypes(input: ProductWriteInput): Promise<SkinType[]> {
    const ids = [
      ...new Set(
        (input.skinTypeIds ?? [])
          .concat(input.skinTypeId ? [input.skinTypeId] : [])
          .filter(Boolean),
      ),
    ];

    if (ids.length === 0) {
      return [await this.findOrCreateAllSkinType()];
    }

    const found = await this.skinTypeRepository.findBy({ id: In(ids) });
    if (found.length === 0) {
      return [await this.findOrCreateAllSkinType()];
    }
    return found;
  }

  private normalizeBrand(brand?: string | null): string | null {
    if (brand == null) return null;
    const trimmed = brand.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  async create(data: ProductWriteInput): Promise<Product> {
    const name = data.name?.trim();
    if (!name) {
      throw new BadRequestException('Product name is required');
    }

    const existing = await this.productRepository.findOne({
      where: { name: ILike(name) },
    });
    if (existing) {
      throw new ConflictException(
        `A product named "${existing.name}" already exists. Use Restock to add inventory instead of creating a duplicate.`,
      );
    }

    const skinTypes = await this.resolveSkinTypes(data);
    const product = this.productRepository.create({
      name,
      brand: this.normalizeBrand(data.brand ?? null),
      description: data.description,
      image: data.image,
      assetId: data.assetId,
      categoryId: data.categoryId || null,
      stock: data.stock ?? 0,
      price: data.price ?? 0,
      discountPercent: clampDiscountPercent(data.discountPercent ?? 0),
      skinTypes,
      skinTypeId: skinTypes[0]?.id ?? null,
    });

    const saved = await this.productRepository.save(product);
    return this.findHydratedById(saved.id);
  }

  async restock(id: string, quantity: number): Promise<Product> {
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new BadRequestException(
        'Restock quantity must be a positive number.',
      );
    }
    const product = await this.findHydratedById(id);
    product.stock = (product.stock ?? 0) + Math.floor(quantity);
    await this.productRepository.save(product);
    return this.findHydratedById(id);
  }

  async update(id: string, data: ProductWriteInput): Promise<Product> {
    const product = await this.findHydratedById(id);

    if (data.name !== undefined) {
      const name = data.name.trim();
      if (!name) throw new BadRequestException('Product name is required');
      product.name = name;
    }
    if (data.brand !== undefined) {
      product.brand = this.normalizeBrand(data.brand);
    }
    if (data.description !== undefined) product.description = data.description;
    if (data.image !== undefined) product.image = data.image;
    if (data.assetId !== undefined) product.assetId = data.assetId;
    if (data.categoryId !== undefined) {
      product.categoryId = data.categoryId || null;
    }
    if (data.stock !== undefined) product.stock = data.stock;
    if (data.price !== undefined) product.price = data.price;
    if (data.discountPercent !== undefined) {
      product.discountPercent = clampDiscountPercent(data.discountPercent);
    }

    if (data.skinTypeIds !== undefined || data.skinTypeId !== undefined) {
      const skinTypes = await this.resolveSkinTypes(data);
      product.skinTypes = skinTypes;
      product.skinTypeId = skinTypes[0]?.id ?? null;
    }

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
