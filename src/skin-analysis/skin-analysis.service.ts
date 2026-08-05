import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { SkinAnalysis } from './skin-analysis.entity.js';
import { Product } from '../product/product.entity.js';

export interface SkinAnalysisListQuery {
  page?: number;
  pageSize?: number;
  search?: string;
}

@Injectable()
export class SkinAnalysisService {
  constructor(
    @InjectRepository(SkinAnalysis)
    private readonly repo: Repository<SkinAnalysis>,
    @InjectRepository(Product)
    private readonly productRepo: Repository<Product>,
  ) {}

  async create(data: {
    customerId: string;
    imageUrl: string;
    assetId?: string | null;
    adviceText: string;
    mentionedProductIds?: string[];
  }): Promise<SkinAnalysis> {
    const row = this.repo.create({
      customerId: data.customerId,
      imageUrl: data.imageUrl,
      assetId: data.assetId ?? null,
      adviceText: data.adviceText,
      mentionedProductIds: data.mentionedProductIds?.length
        ? data.mentionedProductIds
        : null,
    });
    return this.repo.save(row);
  }

  async findPage(query: SkinAnalysisListQuery) {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(50, Math.max(1, query.pageSize ?? 12));

    const qb = this.repo
      .createQueryBuilder('scan')
      .leftJoinAndSelect('scan.customer', 'customer')
      .leftJoinAndSelect('customer.skinType', 'skinType')
      .orderBy('scan.createdAt', 'DESC')
      .skip((page - 1) * pageSize)
      .take(pageSize);

    const search = query.search?.trim();
    if (search) {
      qb.andWhere(
        `(
          LOWER(customer.fullName) LIKE :search
          OR LOWER(COALESCE(customer.telegramUsername, '')) LIKE :search
          OR LOWER(customer.phone) LIKE :search
          OR LOWER(scan.adviceText) LIKE :search
        )`,
        { search: `%${search.toLowerCase()}%` },
      );
    }

    const [items, total] = await qb.getManyAndCount();
    return { items, total, page, pageSize };
  }

  async findOne(id: string) {
    const scan = await this.repo.findOne({
      where: { id },
      relations: { customer: { skinType: true } },
    });
    if (!scan) throw new NotFoundException(`Skin analysis ${id} not found`);

    const ids = (scan.mentionedProductIds ?? []).filter(Boolean);
    const mentionedProducts = ids.length
      ? await this.productRepo.find({
          where: { id: In(ids) },
          relations: { category: true, skinType: true, skinTypes: true },
        })
      : [];

    return { ...scan, mentionedProducts };
  }
}
