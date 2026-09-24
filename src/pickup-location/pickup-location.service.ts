import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PickupLocation } from './pickup-location.entity.js';

@Injectable()
export class PickupLocationService {
  constructor(
    @InjectRepository(PickupLocation)
    private readonly repo: Repository<PickupLocation>,
  ) {}

  findAll(): Promise<PickupLocation[]> {
    return this.repo.find({ order: { name: 'ASC' } });
  }

  findEnabled(): Promise<PickupLocation[]> {
    return this.repo.find({
      where: { enabled: true },
      order: { name: 'ASC' },
    });
  }

  async findOne(id: string): Promise<PickupLocation> {
    const loc = await this.repo.findOne({ where: { id } });
    if (!loc) throw new NotFoundException(`Pickup location ${id} not found`);
    return loc;
  }

  async create(data: {
    name: string;
    address: string;
    enabled?: boolean;
  }): Promise<PickupLocation> {
    const loc = this.repo.create({
      name: data.name.trim(),
      address: data.address.trim(),
      enabled: data.enabled ?? true,
    });
    return this.repo.save(loc);
  }

  async update(
    id: string,
    data: { name?: string; address?: string; enabled?: boolean },
  ): Promise<PickupLocation> {
    const loc = await this.findOne(id);
    if (data.name !== undefined) loc.name = data.name.trim();
    if (data.address !== undefined) loc.address = data.address.trim();
    if (data.enabled !== undefined) loc.enabled = data.enabled;
    return this.repo.save(loc);
  }

  async remove(id: string): Promise<void> {
    const loc = await this.findOne(id);
    await this.repo.remove(loc);
  }
}
