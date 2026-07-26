import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SkinType } from './skin-type.entity.js';

@Injectable()
export class SkinTypeService {
  constructor(
    @InjectRepository(SkinType)
    private readonly repo: Repository<SkinType>,
  ) {}

  findAll(): Promise<SkinType[]> {
    return this.repo.find({ order: { name: 'ASC' } });
  }

  async findOne(id: string): Promise<SkinType> {
    const skin = await this.repo.findOne({ where: { id } });
    if (!skin) throw new NotFoundException(`Skin type ${id} not found`);
    return skin;
  }

  async create(data: {
    name: string;
    description?: string;
  }): Promise<SkinType> {
    const existing = await this.repo.findOne({
      where: { name: data.name.trim() },
    });
    if (existing) throw new ConflictException('Skin type name already exists');

    const skin = this.repo.create({
      name: data.name.trim(),
      description: data.description?.trim() ?? null,
    });
    return this.repo.save(skin);
  }

  async update(
    id: string,
    data: { name?: string; description?: string },
  ): Promise<SkinType> {
    const skin = await this.findOne(id);
    if (data.name) skin.name = data.name.trim();
    if (data.description !== undefined)
      skin.description = data.description.trim() || null;
    return this.repo.save(skin);
  }

  async remove(id: string): Promise<void> {
    const skin = await this.findOne(id);
    await this.repo.remove(skin);
  }
}
