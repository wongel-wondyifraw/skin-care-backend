import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Category } from './category.entity.js';

@Injectable()
export class CategoryService {
  constructor(
    @InjectRepository(Category)
    private readonly repo: Repository<Category>,
  ) {}

  findAll(): Promise<Category[]> {
    return this.repo.find({ order: { name: 'ASC' } });
  }

  async findOne(id: string): Promise<Category> {
    const cat = await this.repo.findOne({ where: { id } });
    if (!cat) throw new NotFoundException(`Category ${id} not found`);
    return cat;
  }

  async create(data: { name: string; description?: string }): Promise<Category> {
    const existing = await this.repo.findOne({ where: { name: data.name.trim() } });
    if (existing) throw new ConflictException('Category name already exists');
    const cat = this.repo.create({
      name: data.name.trim(),
      description: data.description?.trim() ?? null,
    });
    return this.repo.save(cat);
  }

  async update(id: string, data: { name?: string; description?: string }): Promise<Category> {
    const cat = await this.findOne(id);
    if (data.name) cat.name = data.name.trim();
    if (data.description !== undefined) cat.description = data.description.trim() || null;
    return this.repo.save(cat);
  }

  async remove(id: string): Promise<void> {
    const cat = await this.findOne(id);
    await this.repo.remove(cat);
  }
}
