import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PickupLocation } from './pickup-location.entity.js';

export type PickupLocationInput = {
  name: string;
  description?: string | null;
  enabled?: boolean;
};

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

  async create(data: PickupLocationInput): Promise<PickupLocation> {
    const name = data.name?.trim();
    const description =
      data.description != null && String(data.description).trim()
        ? String(data.description).trim()
        : null;
    if (!name) {
      throw new BadRequestException('Name is required');
    }
    if (!description) {
      throw new BadRequestException('Description is required');
    }
    const loc = this.repo.create({
      name,
      description,
      address: '',
      lat: null,
      lon: null,
      enabled: data.enabled ?? true,
    });
    return this.repo.save(loc);
  }

  async update(
    id: string,
    data: Partial<PickupLocationInput>,
  ): Promise<PickupLocation> {
    const loc = await this.findOne(id);
    if (data.name !== undefined) {
      const name = data.name.trim();
      if (!name) throw new BadRequestException('Name is required');
      loc.name = name;
    }
    if (data.description !== undefined) {
      const description =
        data.description != null && String(data.description).trim()
          ? String(data.description).trim()
          : null;
      if (!description) {
        throw new BadRequestException('Description is required');
      }
      loc.description = description;
    }
    if (data.enabled !== undefined) loc.enabled = data.enabled;
    // Clear map fields — pickups are text-only
    loc.lat = null;
    loc.lon = null;
    if (loc.address == null) loc.address = '';
    return this.repo.save(loc);
  }

  async remove(id: string): Promise<void> {
    const loc = await this.findOne(id);
    await this.repo.remove(loc);
  }
}
