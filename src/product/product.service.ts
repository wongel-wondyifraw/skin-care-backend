import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Product } from './product.entity';
import { SkinType } from '../skin-type/skin-type.entity';

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

  async findOne(id: string): Promise<Product> {
    const product = await this.productRepository.findOne({
      where: { id },
      relations: { category: true, skinType: true },
    });
    if (!product) {
      throw new NotFoundException(`Product with ID ${id} not found`);
    }
    return product;
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
    if (!data.skinTypeId) {
      const allSkin = await this.findOrCreateAllSkinType();
      data.skinTypeId = allSkin.id;
    }
    const product = this.productRepository.create(data);
    const saved = await this.productRepository.save(product);
    return this.findOne(saved.id);
  }

  async update(id: string, data: Partial<Product>): Promise<Product> {
    if (
      Object.prototype.hasOwnProperty.call(data, 'skinTypeId') &&
      !data.skinTypeId
    ) {
      const allSkin = await this.findOrCreateAllSkinType();
      data.skinTypeId = allSkin.id;
    }
    const product = await this.findOne(id);
    Object.assign(product, data);
    await this.productRepository.save(product);
    return this.findOne(id);
  }

  async remove(id: string): Promise<void> {
    const result = await this.productRepository.delete(id);
    if (result.affected === 0) {
      throw new NotFoundException(`Product with ID ${id} not found`);
    }
  }
}
